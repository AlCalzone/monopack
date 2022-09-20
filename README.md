# monopack

Like `npm pack` or `yarn pack`, but for entire monorepos.
This works by editing the `package.json` files in the resulting tarballs so that they reference each other.

## Usage

Run this inside the root of your monorepo:

```sh
npx @alcalzone/monopack [--target <target-dir>] [--no-version]
```

To specify a target directory, use the `--target` flag. By default, the tarballs will be created in the `.monopack` directory.

By default, the package version will be included in the tarball name. To disable this, use the `--no-version` flag.
