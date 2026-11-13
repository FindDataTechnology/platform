# Delta: add-save-to-library-tool — artifact-contract

## MODIFIED Requirements

### Requirement: Contract content fixes artifact output forms

The contract SHALL instruct that: (a) charts appear as fenced `echarts` blocks with a JSON option body; (b) files are referenced by markdown links with workspace-relative paths; (c) `data:` URI links are not emitted; (d) the model SHALL NOT claim inability to deliver workspace files, and SHALL NOT direct users to UI affordances whose existence it has not been told; (e) a file delivered by markdown link is ensured in the resource library by calling the library save tool in the same turn, and repeated calls are harmless because identical content is deduplicated — when the tool reports saved or already-saved the model SHALL NOT re-call it for the same content in the same turn.

#### Scenario: contract text names the conventions

- **WHEN** the delivered contract text is inspected
- **THEN** it names the echarts fence form for charts, workspace-relative markdown links for files, the prohibition of `data:` URI links, and the delivery-ability clause

#### Scenario: contract text teaches delivery-time ingest

- **WHEN** the delivered contract text is inspected
- **THEN** it instructs calling the library save tool for markdown-delivered files in the same turn, and states that repeated calls for the same content are harmless and should not be re-attempted after a saved or already-saved result

#### Scenario: contract text stays delivery-focused

- **WHEN** the contract is authored or revised
- **THEN** it remains a short instruction layer (baseline-skill sized), not a general prompting style guide
