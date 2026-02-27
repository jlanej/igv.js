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
- **Sample QC** – load a per-sample QC file (e.g. VerifyBamID freemix) to
  display trio-aggregated metrics and color-coded warnings in the variant table
- **TSV export** – download filtered + curated variants as a TSV file
- **XLSX export** – publication-quality Excel workbook with a styled "Variants"
  data sheet and per-variant IGV screenshot tabs with cross-sheet hyperlinks

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
7. **Export** filtered + curated variants as TSV or publication-quality XLSX

Curation state is saved automatically to a JSON file alongside the variants
TSV.  Keys use a stable `chrom:pos:ref:alt` format (with optional
`trio_id` / `sample_id` suffix for multi-sample datasets) so curation data
survives changes to the variant list across sessions.  Legacy curation files
using row-index keys are automatically migrated on first load.

### XLSX Export

The **Export XLSX** button generates a publication-ready workbook containing:

- **Variants** sheet – styled table of all filtered variants with curation
  status, auto-filters, and frozen header row
- **Per-variant screenshot tabs** – one worksheet per variant with the IGV
  alignment view embedded as a PNG image, variant metadata, and a back-link
  to the main Variants sheet
- **Cross-sheet hyperlinks** – the Variants sheet includes a "📷 View" link
  in each row that jumps to the corresponding screenshot tab

If IGV has not yet been loaded (no variant clicked), the XLSX is exported
with the data sheet only.

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


