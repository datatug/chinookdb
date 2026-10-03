# Universal concepts (temporary copy)

These files are a temporary copy of the universal concepts that
`model/chinook.meaning.yaml` reuses: country, currency, money amount, customer,
invoice, invoice line, revenue, person, employee, population and per capita.

They are planned to live in their own public repository,
`github.com/meaninggraph/core`, which does not exist yet. The meaning file
already refers to them by that address (`meaning://github.com/meaninggraph/core/<concept>`),
and `pnpm test:model` resolves those references against this directory.

When the public repository exists:

1. pin the references in `model/chinook.meaning.yaml` with `?ref=<commit>`;
2. change the one `meaningSources` entry in `scripts/lib/meaning.mjs` from
   this directory to the repository (the replacement line is in the comment
   above it);
3. delete this directory and run `pnpm generate`.

Do not edit these files here; changes belong in the universal repository.
They have no licence of their own yet (see the repository README).
