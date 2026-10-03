---
ovdb: 1
publish: [./ovdb.yaml]
---
# OpenVaultDB publisher manifest

This repository publishes the Chinook sample database to the
[OpenVaultDB](https://github.com/openvaultdb) Directory.

The list above names the manifest files the Directory may read. It is an
explicit list of paths relative to the repository root, never a glob, so only
files named here are published.
[`ovdb.yaml`](ovdb.yaml) describes one database: its canonical identity, the
live deployment, the ModelSpec model, the MeaningGraph meaning file, the
publisher and the licences. The manifest format is a draft
(`ovdb-manifest/draft-1`).
