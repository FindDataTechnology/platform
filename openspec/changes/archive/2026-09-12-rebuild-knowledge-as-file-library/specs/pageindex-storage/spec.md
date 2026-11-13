# pageindex-storage Delta

## REMOVED Requirements

### Requirement: Users can upload PDF, Markdown, text, and URL documents

**Reason**: superseded by `document-management` (local extraction, immediate readiness). Ingest behavior is specified there.

### Requirement: Users can upload Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV, and HTML documents

**Reason**: superseded by `document-management` format handling under local extraction.

### Requirement: Document records are persisted to SQLite

**Reason**: record persistence is covered by the project database capability; the PageIndex-specific `doc_index` tree persistence is deleted with the pipeline.

### Requirement: Users can list and delete documents

**Reason**: superseded by `document-management` (no-LLM ingest) and `document-management-ui` (library surface).

### Requirement: Users can query indexed documents

**Reason**: the PageIndex reasoning-retrieval query path is deleted; retrieval is specified by `document-search-index` and `document-library-tools`.
