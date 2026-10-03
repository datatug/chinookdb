# Vendored meaning files (temporary)

`meaninggraph-core/` is a byte-for-byte copy of the universal concepts and the
meaning-file schema that `model/chinook.meaning.yaml` uses. They are planned to
live in their own public repository, `github.com/meaninggraph/core`, which does
not exist yet. The meaning file already refers to them by that address
(`meaning://github.com/meaninggraph/core/<concept>`), and `pnpm test:model`
resolves those references, and validates every meaning file, against this copy.

The copy is CC0-1.0 (`meaninggraph-core/LICENSE`). Do not edit it here:
changes belong upstream, and the copy is replaced whole.

When the public repository exists:

1. pin the references in `model/chinook.meaning.yaml` with `?ref=<commit>`;
2. change the one `meaningSources` entry in `scripts/lib/meaning.mjs` from
   this directory to the repository (the replacement line is in the comment
   above it), and point `schemaPath` in `scripts/test-model.mjs` at the
   published schema;
3. delete this directory and run `pnpm generate`.
