// Script to pack the monorepo packages for production, but locally
import { rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

async function readJson(filePath: string): Promise<any> {
	const content = await readFile(filePath, "utf8");
	return JSON.parse(content);
}

async function writeJson(
	filePath: string,
	data: unknown,
	spaces = 2,
): Promise<void> {
	await writeFile(
		filePath,
		`${JSON.stringify(data, null, spaces)}\n`,
		"utf8",
	);
}

async function ensureDir(dirPath: string): Promise<void> {
	await mkdir(dirPath, { recursive: true });
}

async function removeDir(dirPath: string): Promise<void> {
	await rm(dirPath, { recursive: true, force: true });
}

async function emptyDir(dirPath: string): Promise<void> {
	await removeDir(dirPath);
	await ensureDir(dirPath);
}

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
		const packageJson = await readJson(
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
	await ensureDir(outDir);
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
			await emptyDir(workspaceTmpDir);
			await tar.extract({
				file: workspace.tarball,
				cwd: workspaceTmpDir,
			});

			// modify package.json
			const packageJsonPath = path.join(
				workspaceTmpDir,
				"package/package.json",
			);
			const packageJson = await readJson(packageJsonPath);
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
			await writeJson(packageJsonPath, packageJson, 2);

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
			await removeDir(workspaceTmpDir);

			// Rename the original tarball if necessary
			if (noVersion) {
				await rename(
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
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
	console.error(err);
	process.exit(1);
});
