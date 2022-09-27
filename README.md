# monopack

Like `npm pack` or `yarn pack`, but for entire monorepos.
This works by editing the `package.json` files in the resulting tarballs so that they reference each other.

## Usage

Run this inside the root of your monorepo:

```sh
npx @alcalzone/monopack [--target <target-dir>] [--no-version] [--absolute]
```

To specify a target directory, use the `--target` flag. By default, the tarballs will be created in the `.monopack` directory.

By default, the package version will be included in the tarball name. To disable this, use the `--no-version` flag.

To reference the dependency tarballs using absolute paths (`file:/path/to/dependency.tgz`) instead of relative paths (`file:../dependency.tgz`), use the `--absolute` flag. This may be necessary for some `yarn` versions that don't resolve the referenced tarballs correctly. Note that the tarballs CANNOT be moved when doing this.
