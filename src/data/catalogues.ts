// The three catalogues where Chinook is listed: its database, its model and its meaning graph. The home
// page and the model page both show them; scripts/test-worker.ts asserts that both pages link them.
export const catalogues = [
  { name: 'OVDB Directory', text: 'The database.', url: 'https://directory.openvaultdb.com/databases/chinook/' },
  { name: 'ModelSpec registry', text: 'The model.', url: 'https://modelspec.org/registry/models/chinook/' },
  { name: 'MeaningGraph', text: 'The meaning graph.', url: 'https://meaninggraph.io/graphs/chinook/' },
] as const;
