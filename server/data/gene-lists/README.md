# Gene-list membership annotations

Drop a plain-text gene list into this directory and the export will gain one
**Yes/No membership column** on the Gene Summary tab for it. This is the
licence-safe way to include annotations from sources whose *content* cannot be
redistributed (e.g. **COSMIC Cancer Gene Census**, **OncoKB**): the report
embeds only a membership boolean derived from a symbol list you supply — not the
licensed descriptive data.

## Format

- One file per membership column, ending in `.txt`.
- One HGNC gene symbol per line.
- Lines starting with `#` are comments.
- An optional `# name: <Label>` directive sets the column header (otherwise the
  file name is used).

Example (`cosmic_cgc.txt`):

```
# name: COSMIC CGC
# Cancer Gene Census membership (symbols only; supply from your licensed COSMIC download).
TSC1
TSC2
TP53
BRCA1
```

This produces a Gene Summary column headed **COSMIC CGC** with `Yes` for genes
present in the list and `No` for genes absent from it.

## Notes

- No list files are shipped by default, so no membership column appears until
  you add one.
- Membership columns are gated by `geneAnnotations.geneLists.enabled` in the
  export config (on by default).
- Only symbols are read; any descriptive columns in the file are ignored.
- For **COSMIC**, download the Cancer Gene Census under your own COSMIC licence
  and export just the gene-symbol column into a file here. Only the membership
  flag is embedded in reports, never COSMIC's annotations.
