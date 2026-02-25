// Script to pack the monorepo packages for production, but locally
import fs from "fs-extra";
import path from "path";
import tar from "tar";
import { detectPackageManager } from "@alcalzone/pak";
import crypto from "crypto";

interface Workspace {
	name: string;
	dir: string;
	version: string;
	packageJson: any;
	workspaceDependencies: string[];
	tarball: string;
}

let tmpDir: string;

async function main() {
	const workspaces: Workspace[] = [];

	const targetArgsIndex = process.argv.indexOf("--target");

	let outDir =
		(targetArgsIndex > -1 && process.argv[targetArgsIndex + 1]) ||
		".monopack";
	if (!path.isAbsolute(outDir)) {
		outDir = path.join(process.cwd(), outDir);
	}

	tmpDir = path.join(outDir, `tmp-${crypto.randomBytes(4).toString("hex")}`);

	const noVersion = process.argv.includes("--no-version");
	const absolute = process.argv.includes("--absolute");

	const PQueue = (await import("p-queue")).default;
	const queue = new PQueue({ concurrency: 16 });

	// First pass: read all package.json files
	console.log("Parsing workspace...");
	const pak = await detectPackageManager();
	const workspaceDirs = await pak.workspaces();
	for (const workspaceDir of workspaceDirs) {
		const packageJson = await fs.readJson(
			path.join(workspaceDir, "package.json"),
		);
		if (packageJson.private) continue;

		const { name, version } = packageJson;

		workspaces.push({
			name,
			dir: workspaceDir,
			version,
			packageJson,
			workspaceDependencies: [],
			tarball: undefined as any, // will be set later
		});
	}

	// Second pass: find all workspace dependencies
	for (const workspace of workspaces) {
		const { dependencies } = workspace.packageJson;
		if (!dependencies) continue;

		for (const dependency of Object.keys(dependencies)) {
			const isOwn = workspaces.some((w) => w.name === dependency);
			if (isOwn) {
				workspace.workspaceDependencies.push(dependency);
			}
		}
	}

	// Pack all workspaces
	console.log("Packing tarballs...");
	await fs.ensureDir(outDir);
	const packTasks = workspaces
		.map(async (workspace) => {
			console.log(`  ${workspace.name}`);
			const result = await pak.pack({
				workspace: path.relative(pak.cwd, workspace.dir),
				targetDir: outDir,
			});
			if (result.success) {
				workspace.tarball = result.stdout;
			} else {
				console.error(result.stderr);
				process.exit(1);
			}
		})
		.map((promise) => queue.add(() => promise));
	await Promise.all(packTasks);

	// Modify each tarball to point at the other tarballs
	console.log("Modifying workspaces...");
	const modifyTasks = workspaces
		.map(async (workspace) => {
			console.log(`  ${workspace.name} starting...`);

			const workspaceTmpDir = path.join(
				tmpDir,
				`workspace-${crypto.randomBytes(4).toString("hex")}`,
			);

			// extract the tarball
			await fs.emptyDir(workspaceTmpDir);
			await tar.extract({
				file: workspace.tarball,
				cwd: workspaceTmpDir,
			});

			// modify package.json
			const packageJsonPath = path.join(
				workspaceTmpDir,
				"package/package.json",
			);
			const packageJson = await fs.readJSON(packageJsonPath);
			// Replace workspace dependencies with references to local tarballs
			for (const dep of workspace.workspaceDependencies) {
				const depWorkspace = workspaces.find((w) => w.name === dep);
				if (!depWorkspace) {
					console.error(
						`Did not find workspace ${dep}, required by ${workspace.name}`,
					);
					process.exit(1);
				}
				const targetFileName = noVersion
					? depWorkspace.tarball.replace(
							`-${depWorkspace.version}.tgz`,
							".tgz",
						)
					: depWorkspace.tarball;

				packageJson.dependencies[dep] = absolute
					? `file:${targetFileName}`
					: `file:./${path.basename(targetFileName)}`;
			}
			// Avoid accidentally installing dev dependencies
			delete packageJson.devDependencies;
			// write package.json back to disk
			await fs.writeJSON(packageJsonPath, packageJson, { spaces: 2 });

			// Repack the tarball
			await tar.create(
				{
					file: workspace.tarball,
					cwd: workspaceTmpDir,
					gzip: { level: 9 },
				},
				["package"],
			);

			// Clean up
			await fs.remove(workspaceTmpDir);

			// Rename the original tarball if necessary
			if (noVersion) {
				await fs.rename(
					workspace.tarball,
					workspace.tarball.replace(
						`-${workspace.version}.tgz`,
						".tgz",
					),
				);
			}

			console.log(`  ${workspace.name} done!`);
		})
		.map((promise) => queue.add(() => promise));
	await Promise.all(modifyTasks);

	console.log("Done!");
}

main().catch((err) => {
	if (tmpDir) {
		try {
			fs.removeSync(tmpDir);
		} catch {
			// ignore
		}
	}
	console.error(err);
	process.exit(1);
});
