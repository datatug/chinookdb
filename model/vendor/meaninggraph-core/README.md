# MeaningGraph core concepts

Concepts that are not specific to any dataset, in the meaning-file format
`meaning/draft-1` (JSON Schema: `meaning.schema.json` in this directory). A
dataset's meaning file reuses them by address, for example
`meaning://github.com/meaninggraph/core/country`, and binds its own columns to
them.

| File | Concepts |
|---|---|
| `geo.meaning.yaml` | country (a starter subset with ISO 3166-1 codes, English and Russian names, aliases such as "USA"), country-code, city, population |
| `assets.meaning.yaml` | currency (USD, EUR, GBP), money-amount |
| `commerce.meaning.yaml` | customer, invoice, invoice-line, invoice-total, price, unit-price, quantity, revenue |
| `identity.meaning.yaml` | person, organization, employee, manager |
| `calendar.meaning.yaml` | date |
| `statistics.meaning.yaml` | per-capita (a pattern for ratios) |

Concept ids are unique across the whole directory: the file a concept sits in
is packaging, not part of its address. A concept's meaning never changes under
the same id; a different meaning gets a new id, and old concepts are
deprecated, not deleted, so pinned references keep resolving.

Draft: the format may change before `meaning/1`, and the value lists are
starter subsets, not the full ISO lists.

## Licence

Everything in this directory, the schema included, is dedicated to the public
domain under [CC0-1.0](LICENSE): copy it, vendor it and change it without
attribution. ISO codes are facts; names and descriptions are original. A
vendored copy of this directory keeps this README and the `LICENSE` file
byte for byte.
