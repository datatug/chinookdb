---
ovdb: 1
publish: [./ovdb.yaml]
---
# OpenVaultDB publisher manifest (example for a hoster of Chinook)

This is the root `OVDB.md` of a repository that hosts its own copy of the
Chinook sample database and lists it in the
[OpenVaultDB](https://github.com/openvaultdb) Directory. It is an example: the
organisation (`example_org`), the repository (`chinook-hosting`) and every
`example.com` URL in `ovdb.yaml` are placeholders to replace with your own.
This file and `ovdb.yaml` must not be listed in the Directory as they stand.

The list above names the manifest files the Directory may read. It is an
explicit list of paths relative to the repository root, never a glob, so only
files named here are published. A hoster's repository carries only these two
files: `OVDB.md` and [`ovdb.yaml`](ovdb.yaml). The model and the meaning graph
stay in `datatug/chinookdb`, and `ovdb.yaml` points at them by pinned address.
