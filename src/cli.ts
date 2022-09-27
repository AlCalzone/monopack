// Script to pack the monorepo packages for production, but locally
import fs from "fs-extra";
import path from "path";
import type { Stream } from "stream";
import tar from "tar-stream";
import zlib from "zlib";
import { detectPackageManager } from "@alcalzone/pak";

interface Workspace {
	name: string;
	dir: string;
	version: string;
	packageJson: any;
	workspaceDependencies: string[];
	tarball: string;
}

async function stream2buffer(stream: Stream): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const _buf = Array<any>();

		stream.on("data", (chunk) => _buf.push(chunk));
		stream.on("end", () => resolve(Buffer.concat(_buf)));
		stream.on("error", (err) => reject(`error converting stream - ${err}`));
	});
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

	const noVersion = process.argv.includes("--no-version");
	const absolute = process.argv.includes("--absolute");

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
	for (const workspace of workspaces) {
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
	}

	// Modify each tarball to point at the other tarballs
	console.log("Modifying workspaces...");
	for (const workspace of workspaces) {
		console.log(`  ${workspace.name}`);
		const extract = tar.extract();
		const pack = tar.pack();

		extract.on("entry", async (header, stream, next) => {
			if (header.name === "package/package.json") {
				const data = await stream2buffer(stream);
				const packageJson = JSON.parse(data.toString());
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

				// Return data
				pack.entry(header, JSON.stringify(packageJson, null, 2), next);
			} else {
				// pass through
				stream.pipe(pack.entry(header, next));
			}
		});

		extract.on("finish", () => {
			pack.finalize();
		});

		const read = fs.createReadStream(workspace.tarball);
		const unzip = zlib.createGunzip();
		read.pipe(unzip).pipe(extract);

		const zip = zlib.createGzip();
		const write = fs.createWriteStream(workspace.tarball + ".tmp");
		pack.pipe(zip).pipe(write);

		await new Promise((resolve) => write.on("finish", resolve));

		// Replace the original tarball
		await fs.unlink(workspace.tarball);
		const targetFileName = noVersion
			? workspace.tarball.replace(`-${workspace.version}.tgz`, ".tgz")
			: workspace.tarball;
		await fs.rename(workspace.tarball + ".tmp", targetFileName);
	}

	console.log("Done!");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
