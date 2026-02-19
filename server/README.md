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
  notes; curation state is persisted to disk
- **Gene summary** – post-filtering summarization showing genes that harbor
  multiple variants passing current filters
- **TSV export** – download filtered + curated variants as a TSV file

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

Additional columns (e.g. `cadd_score`, `clinvar`, `gnomad_af`) are
automatically displayed and made filterable.

### Alignment File Paths

Paths in the `*_file` and `*_index` columns can be:

- **Relative** – resolved relative to `--data-dir`
- **Absolute URLs** – `https://…` served directly

If index files are co-located with the alignment files and follow standard
naming (`.bam.bai`, `.cram.crai`), the index columns can be omitted.

## CLI Options

| Flag               | Default                            | Description                    |
|--------------------|------------------------------------|--------------------------------|
| `--variants`       | `example_data/variants.tsv`        | Path to variant TSV file       |
| `--data-dir`       | `example_data/`                    | Directory with BAM/CRAM files  |
| `--genome`         | `hg38`                             | Reference genome for igv.js    |
| `--port`           | `3000`                             | HTTP port                      |
| `--curation-file`  | `<variants>.curation.json`         | Curation persistence file      |

## HPC Deployment

### Docker / Singularity (recommended)

Most HPC clusters don't have Node.js or npm available.  Building a Docker
image and converting it to a Singularity/Apptainer container is the most
portable approach.

**Build the Docker image** (on a machine with Docker):

```bash
# From the repo root
docker build -t igv-variant-review .
```

**Convert to a Singularity SIF** (on a machine with Singularity, or the
cluster login node if Docker images can be pulled):

```bash
# From a Docker archive
docker save igv-variant-review -o igv-variant-review.tar
singularity build igv-variant-review.sif docker-archive://igv-variant-review.tar

# Or build directly from a registry if you pushed the image
# singularity build igv-variant-review.sif docker://registry/igv-variant-review:latest
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
7. **Export** filtered + curated variants as TSV

Curation state is saved automatically to a JSON file alongside the variants
TSV. This file can be shared, version-controlled, or used in downstream
pipelines.

## Architecture

```
Dockerfile              # Multi-stage Docker build (→ Singularity SIF)
.dockerignore           # Docker build exclusions
server/
├── server.js           # Express server & REST API
├── package.json        # Dependencies
├── public/
│   ├── index.html      # Web UI
│   ├── app.js          # Client-side application logic
│   └── styles.css      # Styling
├── example_data/
│   └── variants.tsv    # Example variant file
└── README.md           # This file
```

The server loads variant data from a TSV file into memory, serves a REST API
for filtering and curation, and provides a static file server for the web UI
and genomic data files.  igv.js is loaded from the parent repository's
`dist/` directory.
