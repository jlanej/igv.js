# IGV De Novo Variant Review Server

An HPC-deployable web service for browsing, reviewing, and curating de novo
variants in trio (child / mother / father) sequencing data.  Built on
[igv.js](https://github.com/igvteam/igv.js), the service is designed to be
launched on a cluster node and accessed from a local browser (e.g. via
OpenDemand desktop access).

## Features

- **Variant browsing** – paginated table of variants with sortable columns
- **Dynamic filtering** – filter on any annotation column (gene, impact,
  frequency, inheritance, curation status, etc.)
- **IGV alignment review** – click a variant to load child / mother / father
  alignment tracks at the variant position
- **Manual curation** – mark variants as Pass / Fail / Uncertain with free-text
  notes; curation state is persisted to disk using stable genomic-coordinate
  keys (`chrom:pos:ref:alt`) that survive row reordering and variant
  additions/removals
- **Gene summary** – post-filtering summarization showing genes that harbour
  multiple variants passing current filters
- **Lollipop plots** – per-gene mutation lollipop plots with protein domain
  overlays (fetched from UniProt)
- **Gene annotations** – pluggable gene-level annotations on the Gene Summary
  sheet: MyGene.info (name, summary, OMIM, pathways, type), gnomAD constraint
  (LOEUF/pLI), ClinVar P/LP counts, and Yes/No gene-list membership (e.g. COSMIC)
- **Impact counts** – per-gene counts of HIGH/MODERATE/LOW/ALL-impact variants
  passing review, on the Gene Summary sheet
- **Gene convergence** – a Gene Analysis tab showing whether singleton genes
  stack up on a shared constraint tier, ClinVar history, or protein domain,
  counted by distinct individuals and stratified by curation × impact tier
- **Contamination metrics** – per-variant kraken2 species/contamination summary
  in the Variants sheet and above each per-variant IGV screenshot
- **Sample QC** – load a per-sample QC file (e.g. VerifyBamID freemix) to
  display trio-aggregated metrics and color-coded warnings in the variant table
- **Sample summary** – per-sample variant counts by impact and frequency
  threshold, with cohort-level statistics (mean, median, standard deviation)
- **TSV export** – download filtered + curated variants as a TSV file
- **XLSX export** – publication-quality Excel workbook with styled data sheets,
  per-variant IGV screenshot tabs, gene lollipop plot tabs, cross-sheet
  hyperlinks (including gene name→lollipop navigation), and configurable
  variant column selection
- **HTML export** – interactive single-page HTML report bundled as a ZIP
  archive, with a sortable/filterable variant table, screenshot gallery with
  modal viewer, gene summary cards, and embedded data URIs for self-contained
  viewing
- **Export configuration** – configurable export settings (saved/loaded from
  disk) controlling which sheets, visual elements, gene annotations, and
  variant column categories are included in XLSX and HTML exports

## Quick Start

```bash
# 1. Install dependencies (from the server/ directory)
cd server
npm install

# 2. Build igv.js (from the repo root – only needed once)
cd ..
npm install
npm run build
cd server

# 3. Start the server with your data
node server.js \
  --variants /path/to/your/variants.tsv \
  --data-dir /path/to/bam_cram_files \
  --sample-qc /path/to/sample_qc.tsv \
  --genome hg38 \
  --port 3000

# 4. Open in your browser
#    http://127.0.0.1:3000
```

To try with example data (no alignment files – the table and filtering still
work):

```bash
cd server
npm install
cd .. && npm install && npm run build && cd server
node server.js
# Open http://127.0.0.1:3000
```

## Variant TSV Format

The input file is a **tab-separated** file with a header row.  Four columns are
required; all others are treated as filterable annotations.

### Required Columns

| Column  | Description                        |
|---------|------------------------------------|
| `chrom` | Chromosome (e.g. `chr1`)           |
| `pos`   | 1-based position                   |
| `ref`   | Reference allele                   |
| `alt`   | Alternate allele                   |

### Recommended Columns

| Column            | Description                                          |
|-------------------|------------------------------------------------------|
| `gene`            | Gene symbol – enables gene summary tab               |
| `impact`          | Variant impact (HIGH / MODERATE / LOW / MODIFIER)    |
| `frequency`       | Population allele frequency                          |
| `inheritance`     | Inheritance pattern (de_novo / inherited / unknown)  |
| `quality`         | Variant quality score                                |
| `child_gt`        | Child genotype (e.g. `0/1`)                          |
| `mother_gt`       | Mother genotype                                      |
| `father_gt`       | Father genotype                                      |
| `child_file`      | Path to child BAM/CRAM (relative to `--data-dir`)    |
| `child_index`     | Path to child index file (.bai/.crai)                |
| `mother_file`     | Path to mother BAM/CRAM                              |
| `mother_index`    | Path to mother index file                            |
| `father_file`     | Path to father BAM/CRAM                              |
| `father_index`    | Path to father index file                            |
| `child_vcf`       | Path to child VCF file (.vcf.gz)                     |
| `child_vcf_index` | Path to child VCF index file (.vcf.gz.tbi)           |
| `mother_vcf`      | Path to mother VCF file (.vcf.gz)                    |
| `mother_vcf_index`| Path to mother VCF index file (.vcf.gz.tbi)          |
| `father_vcf`      | Path to father VCF file (.vcf.gz)                    |
| `father_vcf_index`| Path to father VCF index file (.vcf.gz.tbi)          |
| `child_vcf_id`    | Child sample ID in the VCF                           |
| `mother_vcf_id`   | Mother sample ID in the VCF                          |
| `father_vcf_id`   | Father sample ID in the VCF                          |

Additional columns (e.g. `cadd_score`, `clinvar`, `gnomad_af`) are
automatically displayed and made filterable.

### Alignment File Paths

Paths in the `*_file` and `*_index` columns can be:

- **Relative** – resolved relative to `--data-dir`
- **Absolute URLs** – `https://…` served directly

If index files are co-located with the alignment files and follow standard
naming (`.bam.bai`, `.cram.crai`), the index columns can be omitted.

### Per-Trio VCF Tracks

Each trio can have its own VCF file specified via the `*_vcf`, `*_vcf_index`,
and `*_vcf_id` columns.  When a variant row contains these columns, a VCF
track is loaded in IGV alongside the alignment tracks.  The `*_vcf_id` columns
identify which sample in the multi-sample VCF corresponds to each family
member.

When all three members share the same VCF file (common for multi-sample trio
VCFs), the file is de-duplicated and loaded as a single track annotated with
all sample roles.

If no per-variant VCF columns are present, the global `--vcf` CLI flag is
used as a fallback.

## Sample QC File (optional)

A **tab-separated** sample QC file can be loaded with `--sample-qc <path>` to
display per-trio quality control metrics and apply colored warnings to
variant table rows.  This is useful for flagging contaminated samples (e.g.
VerifyBamID freemix) or low-coverage samples before curating variants.

### Required Columns

| Column      | Description                                          |
|-------------|------------------------------------------------------|
| `trio_id`   | Identifier for the trio (must match `trio_id` in the variant TSV for variant-level warnings) |
| `role`      | Family member role: `proband`, `mother`, or `father` |
| `sample_id` | Sample identifier for the individual                 |

### QC Metric Columns

All additional columns are treated as numeric QC metrics (e.g. `freemix`,
`mean_coverage`, `chimeric_rate`).  Values are displayed per-role in the
**Sample QC** tab and the worst-case value across the trio determines the
row-level warning status.

### Example File

```tsv
trio_id	role	sample_id	freemix	mean_coverage
TRIO_A	proband	SAMPLE_001	0.005	35.2
TRIO_A	mother	SAMPLE_002	0.012	30.1
TRIO_A	father	SAMPLE_003	0.002	32.5
TRIO_B	proband	SAMPLE_004	0.045	28.3
TRIO_B	mother	SAMPLE_005	0.008	31.7
TRIO_B	father	SAMPLE_006	0.003	29.8
```

### Freemix Thresholds

The `freemix` column is classified into tiers automatically:

| Status       | Freemix Range | Interpretation                                |
|--------------|---------------|-----------------------------------------------|
| **Pass**     | ≤ 0.01 (≤1%)  | Clean – no special handling needed             |
| **Warn**     | 0.01–0.03     | Caution – apply stricter DNM evidence filters  |
| **Fail**     | 0.03–0.05     | Exclude sample/trio from DNM detection         |
| **Critical** | ≥ 0.05 (≥5%)  | Hard fail – results are usually unreliable     |

The thresholds are exposed via `/api/config` → `qcMetricThresholds` and can
be extended server-side for additional metrics by adding entries to the
`QC_METRIC_THRESHOLDS` object in `server.js`.

### Linking to Variants

If the variant TSV contains a `trio_id` column, variants are automatically
annotated with their trio's worst-case QC status.  This status appears as a
colored dot + badge in the variant table's **QC** column.

### UI Features

- **Sample QC tab** – aggregated view with one row per trio, metrics pivoted
  by role (proband / mother / father), and color-coded cells
- **Variant table warnings** – QC status badge next to each variant when a
  matching trio is found in the QC data
- **XLSX export** – includes a "Sample QC" sheet with styled and
  color-coded status cells

## Trio BED Tracks (Kraken2 Species Annotation)

Species-annotated BED tracks produced by
[kmer_denovo_filter](https://github.com/jlanej/kmer_denovo_filter) can be
loaded alongside alignment tracks to visualize per-read Kraken2 classification
results.  This is useful for **cross-species contamination assessment** during
clinical variant curation.

### Supported BED Types

| File                                    | Description                                      |
|-----------------------------------------|--------------------------------------------------|
| `*.kraken2_spans.bed.gz`                | Aligned genomic span of each classified read     |
| `*.kraken2_spans_expanded.bed.gz`       | Soft-clip–expanded spans for chimera visualization |
| `*.kraken2_reads.bed.gz`                | Per-read classification detail                   |

All files follow the 15-column BED format from kmer_denovo_filter, with
columns for taxon name, domain, guard status, non-human flag, read set
(DKA/DKU), mapping quality, soft-clip lengths, and split-read indicators.
Files should be bgzipped and tabix-indexed (`.tbi`) for efficient region
queries.

### Supplying BED Tracks via CLI

Use `--bed-tracks` to load global BED tracks that apply to all variants.
The argument accepts `label:path` pairs:

```bash
node server.js \
  --variants variants.tsv \
  --data-dir /path/to/data \
  --bed-tracks "Kraken2 Spans:/path/to/trio.kraken2_spans.bed.gz" \
  --bed-tracks "Expanded Spans:/path/to/trio.kraken2_spans_expanded.bed.gz"
```

Multiple `--bed-tracks` flags can be specified.  Within a single flag value,
comma-separated entries are also supported:

```bash
--bed-tracks "Spans:spans.bed.gz,Expanded:expanded.bed.gz"
```

If the label is omitted, the filename (without extension) is used as the
track name.  Paths are resolved relative to `--data-dir`.

### Per-Variant BED Tracks via TSV Columns

BED tracks can also be specified per-variant in the TSV file using columns
that end with `_kraken2_spans_bed`, `_kraken2_expanded_bed`, or
`_kraken2_reads_bed`:

| Column                      | Description                                  |
|-----------------------------|----------------------------------------------|
| `kraken2_spans_bed`         | Path to standard span BED (global)           |
| `kraken2_expanded_bed`      | Path to expanded span BED (global)           |
| `kraken2_reads_bed`         | Path to per-read detail BED (global)         |
| `child_kraken2_spans_bed`   | Path to child-specific span BED              |

Paths follow the same resolution rules as alignment files (relative to
`--data-dir` or absolute URLs).

### UI Features

- **BED track toggle** – checkbox in the IGV controls header to show/hide
  BED annotation tracks without removing alignment tracks
- **BED display mode** – separate dropdown to set BED track display mode
  (Expanded / Squished / Collapsed) independently from alignment tracks
- **Color coding** – BED tracks are color-coded by type: blue for standard
  spans, orange for expanded spans, green for per-read detail
- **Species metrics panel** – a summary panel below the IGV viewer that
  displays per-variant contamination assessment:
  - Overall contamination tier (Clean / Caution / Concern / High)
  - Read counts (total, non-human, DKA/DKU)
  - Domain breakdown (Bacteria, Human, Viruses, etc.)
  - Top taxa (species-level classification)
  - Guard status distribution (PASS, HHG, HUMAN, etc.)
  - Clipping statistics (mean soft-clip lengths, high-clip read count)

### Species Metrics API

The server provides a REST API for species metrics:

```
GET /api/species-metrics
GET /api/species-metrics?variant_id=<id>
GET /api/species-metrics?variant_key=<chr:pos:ref:alt>
```

Returns per-variant or global species composition summaries parsed from the
configured BED files.

### Contamination Assessment Tiers

The species metrics module classifies the non-human read fraction into tiers:

| Tier        | Non-Human Fraction | Interpretation                              |
|-------------|-------------------|---------------------------------------------|
| **Clean**   | ≤ 2%              | Minimal non-human signal – likely background |
| **Caution** | 2–5%              | Low-level – apply stricter variant filters   |
| **Concern** | 5–15%             | Moderate – investigate further               |
| **High**    | ≥ 15%             | High – likely contamination artifact         |

### Docker Usage

BED track files should be mounted alongside alignment files:

```bash
docker run -p 3000:3000 \
  -v /scratch/data:/data \
  igv-variant-review \
  --variants /data/variants.tsv \
  --data-dir /data \
  --bed-tracks "Kraken2 Spans:trio.kraken2_spans.bed.gz" \
  --bed-tracks "Expanded Spans:trio.kraken2_spans_expanded.bed.gz"
```

## CLI Options

| Flag               | Default                            | Description                    |
|--------------------|------------------------------------|--------------------------------|
| `--variants`       | `example_data/variants.tsv`        | Path to variant TSV file       |
| `--data-dir`       | `example_data/`                    | Directory with BAM/CRAM files  |
| `--genome`         | `hg38`                             | Reference genome for igv.js    |
| `--port`           | `3000`                             | HTTP port                      |
| `--curation-file`  | `<variants>.curation.json`         | Curation persistence file      |
| `--host`           | `127.0.0.1`                        | Bind address (use `0.0.0.0` in containers) |
| `--log-level`      | `info`                             | Log verbosity: `debug`, `info`, `warn`, `error` |
| `--sample-qc`      | *(none)*                           | Path to sample QC TSV file (see below) |
| `--check-md5`      | *(off)*                            | Re-enable CRAM MD5 reference checks (see Known Issues) |
| `--bed-tracks`     | *(none)*                           | Species-annotated BED track files (see below) |

## HPC Deployment

### Docker / Singularity (recommended)

Most HPC clusters don't have Node.js or npm available.  Building a Docker
image and converting it to a Singularity/Apptainer container is the most
portable approach.

**Pull a pre-built image** from GitHub Container Registry, or build locally:

```bash
# Pre-built (after CI publishes it)
docker pull ghcr.io/jlanej/igv-variant-review:latest

# Or build locally from the repo root
docker build -t igv-variant-review .
```

**Convert to a Singularity SIF** (on a machine with Singularity, or the
cluster login node if Docker images can be pulled):

```bash
# Directly from the registry
singularity build igv-variant-review.sif docker://ghcr.io/jlanej/igv-variant-review:latest

# Or from a local Docker archive
docker save igv-variant-review -o igv-variant-review.tar
singularity build igv-variant-review.sif docker-archive://igv-variant-review.tar
```

**Run with Singularity on the cluster:**

```bash
singularity run \
  --bind /scratch/project/alignments:/data \
  --bind /scratch/project/denovo_variants.tsv:/variants.tsv \
  --bind /scratch/project/curation.json:/curation.json \
  igv-variant-review.sif \
  --variants /variants.tsv \
  --data-dir /data \
  --curation-file /curation.json \
  --port 8080

# Open browser: http://127.0.0.1:8080
```

**SLURM job script example:**

```bash
#!/bin/bash
#SBATCH --job-name=igv-review
#SBATCH --time=8:00:00
#SBATCH --mem=4G

singularity run \
  --bind /scratch/project/alignments:/data \
  --bind /scratch/project/denovo_variants.tsv:/variants.tsv \
  igv-variant-review.sif \
  --variants /variants.tsv \
  --data-dir /data \
  --port 3000

# Forward the port from a login node:
# ssh -L 3000:$SLURMD_NODENAME:3000 login-node
```

### Native Node.js (if available)

If Node.js is available on your cluster (via `module load` or otherwise),
you can run without containers:

```bash
# From an OpenDemand desktop terminal:
module load nodejs

cd /path/to/igv.js/server
npm install

node server.js \
  --variants /scratch/project/denovo_variants.tsv \
  --data-dir /scratch/project/alignments/ \
  --port 8080

# Then open Firefox/Chrome on the desktop: http://127.0.0.1:8080
```

### Batch Job with Port Forwarding

```bash
# On the login node, forward a port from the compute node:
ssh -L 3000:compute-node:3000 login-node

# In your SLURM script:
node /path/to/igv.js/server/server.js \
  --variants $VARIANTS \
  --data-dir $DATA_DIR \
  --port 3000
```

## Curation Workflow

1. **Filter** variants using the sidebar controls
2. **Click** a variant row to load alignments in the IGV viewer
3. **Review** the trio alignments (child, mother, father)
4. **Curate** using Pass / Fail / Uncertain buttons
5. **Add notes** in the curation text field
6. Switch to **Gene Summary** tab to see genes with multiple passing variants
7. View **Lollipop Plots** for genes with passing variants (📊 button)
8. **Configure export** using the ⚙ panel to choose sheets, columns, and
   visual elements
9. **Export** filtered + curated variants as TSV, publication-quality XLSX, or
   interactive HTML report

Curation state is saved automatically to a JSON file alongside the variants
TSV.  Keys use a stable `chrom:pos:ref:alt` format (with optional
`trio_id` / `sample_id` suffix for multi-sample datasets) so curation data
survives changes to the variant list across sessions.  Legacy curation files
using row-index keys are automatically migrated on first load.

### XLSX Export

The **Export XLSX** button generates a publication-ready workbook containing:

- **Read Me** sheet – a guide to every worksheet plus a per-column data
  dictionary (meaning, source, licence) for the Gene Summary annotations. This
  is the first tab so reviewers can orient before reading the data.
- **Variants** sheet – styled table of filtered variants with curation status,
  auto-filters, frozen header row, and full-row coloring by curation status.
  Gene names link to their lollipop plot worksheets when available. When
  `--bed-tracks` (kraken2 species BEDs) are configured, adds per-variant
  **contamination columns** (assessment, nonhuman %, read counts, top taxa).
- **Gene Summary** sheet – gene-level statistics (total, samples, pass/fail/
  uncertain/pending), **impact counts passing review** (Pass HIGH / MODERATE /
  LOW / ALL), and gene-level annotations (see *Gene annotations* below).
- **Gene Analysis** sheet – gene *convergence*: which shared attributes
  (constraint tier, ClinVar history, protein domain) the review's genes stack
  up on, counted by **distinct individuals** (not variants), stratified by
  curation {pass, all} × impact tier {HIGH, HIGH+MOD, HIGH+MOD+LOW, ALL}, with
  a background-frequency "is this surprising?" cue. See *Gene convergence* below.
- **Sample Summary** sheet – per-sample variant counts by impact group and
  frequency threshold, plus cohort statistics (mean, median, std dev)
- **Sample QC** sheet – trio-aggregated QC metrics (if QC data is loaded)
- **Applied Filters** sheet – key-value summary of active filters
- **Annotation Status** sheet – genome build info, export config summary,
  and any annotation fetch errors
- **Gene Lollipop Plot tabs** – per-gene mutation lollipop plots with protein
  domain overlays, variant counts, and back-links to the Variants sheet
- **Per-variant Screenshot tabs** – one worksheet per variant with the IGV
  alignment view embedded as a PNG image, variant metadata (gene, sample,
  impact, inheritance, frequency, quality, AD, GQ, DKA), a **contamination /
  species panel** above the image when `--bed-tracks` are configured
  (assessment, nonhuman fraction, top taxa, read sets, split/clip counts), and
  a back-link to the main Variants sheet
- **Cross-sheet hyperlinks** – the Variants sheet includes "📷 View" links
  to screenshot tabs and gene name links to lollipop plot tabs

### HTML Export

The **Export HTML** button generates an interactive single-page HTML report
bundled in a ZIP archive.  The report includes:

- **Variants tab** – sortable, filterable, paginated table with status badges
  and screenshot links
- **Screenshots tab** – gallery grid of IGV screenshots with a modal viewer
  supporting keyboard navigation
- **Gene Summary tab** – gene cards with pass/fail/uncertain/pending counts
- **Applied Filters** – displayed as chips above the stats bar
- **Curation Stats** – pass/fail/uncertain/pending summary bar

Screenshots are embedded as base64 data URIs, so the HTML file is fully
self-contained and viewable without extracting the ZIP.

### Export Configuration

The export config panel (⚙ button in the sidebar) controls which elements
are included in XLSX and HTML exports.  Settings can be saved to and loaded
from disk.

| Category | Options |
|----------|---------|
| **Visual Elements** | IGV Screenshots, Lollipop Plots, Protein Domains |
| **Gene Annotations** | Enable/Disable, Gene Name, Summary, OMIM, Pathways, Gene Type; gnomAD constraint; ClinVar P/LP; GenCC MOI + validity; gene-list membership |
| **Impact Counts** | Pass HIGH/MODERATE/LOW/ALL (on), HIGH/MODERATE/LOW/ALL totals (off) |
| **Gene Analysis** | Convergence dimensions (constraint/ClinVar/domain), min-count |
| **Contamination** | Per-variant species columns + screenshot panel (when `--bed-tracks` set) |
| **Worksheets** | Read Me, Gene Summary, Gene Analysis, Sample Summary, Sample QC, Applied Filters, Annotation Status |
| **Variant Columns** | Core (chrom/pos/ref/alt), Gene Info, Frequency, Quality, Genotypes, Allelic Depth, Genotype Quality, Sample Info, File Paths, Other Annotations |

Most options default to **enabled**.  The variant column categories allow
excluding file paths and other technical columns from the exported data.

### Gene annotations

The Gene Summary tab is enriched by a set of pluggable annotation providers
(`annotation-registry.js` + `providers/*`). Each provider fails independently —
a network timeout or missing data file yields blank cells and a note on the
Annotation Status tab, never a failed export.

| Annotation | Columns | Source | Licence |
|------------|---------|--------|---------|
| **Impact passing review** | Pass HIGH / MODERATE / LOW / ALL | curation × impact | n/a |
| **gnomAD constraint** | gnomAD LOEUF, pLI, LoF-constrained | bundled v4 (GRCh38); live API fallback for hg19 | CC0 |
| **ClinVar** | ClinVar P, ClinVar LP, Has P/LP | bundled `data/annotations/*` | public domain |
| **GenCC** | GenCC MOI (mode of inheritance), GenCC Validity | bundled `data/annotations/*` | CC0 |
| **Gene-list membership** | one Yes/No column per list | `data/gene-lists/*.txt` | membership only |
| **MyGene.info** | Gene Name, Type, OMIM, Pathways, Summary | MyGene.info (live) | per source |

- **Impact counts** tally only HIGH/MODERATE/LOW; MODIFIER and blank impacts are
  excluded, so the three Pass columns need not sum to the Pass column.
- **gnomAD** uses v4 (GRCh38) for `hg38` and v2.1.1 (GRCh37) for `hg19`; the
  column header records the version used.
- **Gene-list membership** is the licence-safe way to include restricted
  sources (e.g. COSMIC Cancer Gene Census): drop a symbol list into
  `data/gene-lists/` and the report gains one Yes/No column — only membership is
  embedded, never the licensed content. See `data/gene-lists/README.md`.
- **OMIM** is included as the numeric MIM identifier only (disease-title text is
  licence-restricted and is not embedded).

The bundled ClinVar, gnomAD, and GenCC snapshots are regenerated with
`npm run build-annotation-data` (streams NCBI's public-domain ClinVar
`variant_summary.txt.gz`, the gnomAD v4 constraint table, and the GenCC
submissions export, and slims each to a per-gene JSON).

### Gene convergence (Gene Analysis tab)

When de novo hits are singletons scattered across many genes, the **Gene
Analysis** tab shows whether they *converge* on a shared attribute. For each
grouping dimension it inverts `term → genes` and reports the shared terms:

- **Independent signals** – the primary count is **distinct individuals
  (probands)**, not variants: one proband with several hits in a group counts
  once, so a single hypermutated proband can't look like convergence. Distinct
  genes are shown alongside (so single-proband exports still see gene-level
  convergence). A term is shown only if ≥2 individuals **or** ≥2 genes share it.
- **Dimensions** – constraint tail (gnomAD LOEUF<0.6 / pLI≥0.9), ClinVar P/LP
  history, and **GenCC Mode of Inheritance** are **offline**; protein domain
  (InterPro) comes from MyGene. (MOI convergence — e.g. "5 of my genes are known
  autosomal-dominant disease genes" — is a strong de novo signal.)
- **Stratification** – curation {pass, all} × cumulative impact tier {HIGH,
  HIGH+MOD, HIGH+MOD+LOW, ALL}.
- **Method** – transparent shared-attribute counting (not enrichment p-values,
  which mislead at small gene counts), with a background-frequency column ("is
  this surprising?"). Hypothesis-generating, not diagnostic.

If IGV has not yet been loaded (no variant clicked), exports are generated
with data sheets only (no screenshots).

## Architecture

```
Dockerfile                          # Multi-stage Docker build (→ Singularity SIF)
.dockerignore                       # Docker build exclusions
.github/workflows/
├── server_test.yml                 # CI: run integration tests on push/PR
└── docker_publish.yml              # CI: build & publish Docker image to GHCR
server/
├── server.js                       # Express server & REST API
├── logger.js                       # Leveled logger with timestamps
├── lollipop.js                     # Lollipop plot SVG generator
├── pfam.js                         # Protein domain fetcher (UniProt API)
├── gene-annotations.js             # Gene annotation fetcher (MyGene.info)
├── export-config.js                # Export configuration defaults & helpers
├── package.json                    # Dependencies
├── public/
│   ├── index.html                  # Web UI
│   ├── app.js                      # Client-side application logic
│   └── styles.css                  # Styling
├── test/
│   └── server.test.js              # Integration tests (Mocha/Chai/Supertest)
├── example_data/
│   ├── variants.tsv                # Example variant file
│   └── sample_qc.tsv              # Example sample QC file
└── README.md                       # This file
```

The server loads variant data from a TSV file into memory, serves a REST API
for filtering and curation, and provides a static file server for the web UI
and genomic data files.  igv.js is loaded from the parent repository's
`dist/` directory.

## Known Issues

### CRAM MD5 Checksum Reference Mismatch (Spurious)

**Symptom:** When clicking a variant, some trio members fail to load with
errors like:

```
MD5 checksum reference mismatch for ref 11 pos 120153589..127388592.
recorded MD5: f3d2a2e5c3202e1853d3b82e28e930e6,
calculated MD5: 03c41a3ddc0b92e48d6b3630f069e830
```

Typically one trio member loads fine while the others error.  The error is
**intermittent**: navigating to a different trio and coming back often clears
it.  The failing files are consistent across attempts on the same initial
load, but work on subsequent loads.

**Note on "ref 11":** The number in `ref 11` is the **CRAM-internal
reference sequence ID** (0-indexed position in the CRAM file's `@SQ` header),
not the chromosome number.  In a standard hg38 CRAM with `@SQ` entries
ordered chr1, chr2, …, chrN, `ref 11` corresponds to **chr12** (index 0 =
chr1).  This is expected behavior, not a sign that the wrong chromosome is
being loaded.

**Likely cause – concurrent reference sequence fetching in igv.js:**

CRAM files do not store reference bases; the CRAM decoder fetches reference
sequence on the fly via a `seqFetch` callback and verifies it against an
MD5 checksum embedded in each CRAM slice header.  In igv.js, all reference
sequence requests flow through a shared `CachedSequence` singleton
(`js/genome/cachedSequence.js`).

When a trio is loaded, all three CRAM tracks decode **concurrently** (via
`Promise.all` in `updateViews()`).  Each CRAM slice requests a large
reference region (often 5–10 MB) from `CachedSequence.getSequence()`.

The exact mechanism by which the wrong reference data is returned is not
fully understood, but the circumstantial evidence points to a race:

- The error only occurs on **first load** (cold cache), never on retry
  (warm cache), which is consistent with concurrent cache population
- Only some trio members fail — the first CRAM to decode tends to succeed,
  while later ones (racing) fail
- The `CachedSequence` class has a single `#currentQuery` dedup slot that
  gets overwritten by concurrent requests, and `#trimCache()` can evict
  intervals based on the current view between `await` resumption points

**Prior fix attempts (reverted):**

- **PR #22** modified `js/genome/cachedSequence.js` to replace
  `#currentQuery` with an `#inflightQueries` Map and added
  `#getRecordsWithRetry()` to `js/cram/cramReader.js` to catch and retry
  MD5 errors.

- **PR #26** extended the retry to also clear the `CachedSequence` cache
  via a new `clearCache()` method.

- Both were **reverted in PR #32** because the changes to igv.js core
  caused other issues.  Modifying the upstream igv.js cache and CRAM
  decoder is fragile — these internals are tightly coupled and any change
  risks breaking other functionality.

**Current workaround — MD5 checks disabled by default:**

Instead of modifying igv.js internals, this server sets
`checkSequenceMD5: false` on all CRAM tracks automatically.  This uses a
**supported** config option in the igv.js CRAM reader (see
`js/cram/cramReader.js` line 35) — no igv.js source is modified.

The setting can be controlled in two ways:

1. **Runtime toggle (⚙ gear icon):** Click the ⚙ button in the IGV header
   bar (next to the Display mode selector) to open a settings panel.  The
   "CRAM MD5 checks" checkbox toggles MD5 verification on or off.  The
   choice is persisted in `localStorage` and takes effect on the next
   variant click (tracks are rebuilt each time).

2. **CLI flag:** Pass `--check-md5` on startup to default MD5 checks to on.
   The runtime toggle still overrides this per-browser.

```bash
node server.js --variants variants.tsv --data-dir /data --check-md5
```

When disabled, the CRAM decoder skips the MD5 verification step entirely.
The reads/alignments still load and display correctly — only the
post-decode integrity check is suppressed.  This means genuine reference
mismatches (e.g., CRAM encoded against a different genome build) would also
be silently ignored.


**Why it works on retry (without the flag):** On the second navigation to
the same locus, the reference sequences are already cached in
`#cachedIntervals` (the cache persists across track load/unload cycles since
it lives on the genome singleton).  Cache hits bypass the concurrent fetch
path, so no race occurs.

**Manual workaround (without the flag):** Click a different variant, then
click back.  The second load uses cached reference sequences and succeeds.


