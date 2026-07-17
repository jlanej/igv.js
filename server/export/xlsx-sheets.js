/**
 * XLSX SHEET BUILDERS — every worksheet Test A and Test B emit, and nothing else.
 *
 * Extracted from server.js, which had grown past 4,000 lines with these ~900 in the
 * middle of the Express routes. They belong together and apart: each is a PURE
 * function of (workbook, data, styles) that appends one sheet. None touches the
 * request, the loaded variant array, or any module-level mutable state — which is
 * exactly why they can live here, and why they are unit-testable without a server.
 *
 * The boundary that matters: this module RENDERS, it does not COMPUTE. Every
 * statistic arrives pre-computed from gene-analysis.js (Test A) or dnm-enrichment.js
 * (Test B). If you find yourself doing arithmetic on a p-value here, it is in the
 * wrong file — the engines are the single source of truth for the numbers, and this
 * file's job is to print them, derive live Excel formulas that reproduce them, and
 * explain them.
 *
 * ONE HARD RULE, learned the expensive way: live formulas may use PRE-2007 Excel
 * function names ONLY (POISSON, BINOMDIST — never POISSON.DIST, BINOM.DIST). Any
 * later name needs an `_xlfn.` prefix in the OOXML that ExcelJS does not add, so it
 * ships as a live #NAME? in every row. That shipped once: 264 of them, the whole
 * share column, while the POISSON column beside it was fine.
 */

'use strict'

// Only what this file actually uses. It RENDERS; it does not compute — so it needs the
// engines' pure helpers (binomUpperTail, to show a live formula reproduces a printed p)
// and the annotation sources it prints provenance for, and nothing else. If a require
// for computeConvergence or computeModelEnrichment ever appears here, the boundary has
// been crossed: the statistic belongs upstream.
const {binomUpperTail} = require('../gene-analysis')
const annotationRegistry = require('../annotation-registry')
const geneSets = require('../genesets')
const gnomadProvider = require('../providers/gnomad-provider')
const mitocarta = require('../mitocarta')

/**
 * Build the "Read Me" worksheet: a guide to every tab plus a per-column data
 * dictionary (meaning, source, licence) for the Gene Summary annotations.
 * Placed as the first sheet so reviewers can orient before reading the data.
 * Wrapped by the caller in try/catch — must never break the export.
 */
function buildReadmeSheet(workbook, opts) {
    const {exportCfg, headerFill, headerFont, borderThin, genome, hasGene, hasImpact, hasSampleQc,
        hasScreenshots, hasLollipop} = opts
    const ga = exportCfg.geneAnnotations || {}
    const ws = workbook.addWorksheet('Read Me')
    ws.columns = [
        {header: 'Item', key: 'item', width: 26},
        {header: 'Description', key: 'desc', width: 66},
        {header: 'Source', key: 'src', width: 20},
        {header: 'Licence', key: 'lic', width: 18}
    ]
    const hdr = ws.getRow(1)
    hdr.eachCell(cell => {
        cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin
        cell.alignment = {vertical: 'middle', horizontal: 'left'}
    })
    hdr.height = 22

    let idx = 0
    const row = (item, desc, src, lic) => {
        const r = ws.addRow({item, desc, src: src || '', lic: lic || ''})
        r.eachCell(cell => {
            cell.border = borderThin
            cell.alignment = {vertical: 'top', wrapText: true}
            if (idx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
        })
        idx++
        return r
    }
    const section = (title) => {
        const r = ws.addRow({item: title, desc: '', src: '', lic: ''})
        r.getCell(1).font = {bold: true, color: {argb: 'FF2C3E50'}}
        for (let c = 1; c <= 4; c++) r.getCell(c).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFD6EAF8'}}
        r.eachCell(cell => { cell.border = borderThin })
        idx++
    }

    row('IGV Variant Review — report guide', `Genome build: ${genome}. This workbook was generated from the review session; annotation columns are best-effort (see the Annotation Status tab for any fetch failures).`)

    // --- Worksheet overview ---
    section('Worksheets in this report')
    row('Read Me', 'This guide: worksheet overview, column dictionary, and data sources.')
    row('Variants', 'One row per exported variant. Rows are colour-coded by curation status (Pass/Fail/Uncertain/Pending). When --bed-tracks (kraken2 species BEDs) are configured, adds contamination columns: Contamination (assessment), Nonhuman %, Contam Reads, Nonhuman Reads, Top Taxa.')
    if (hasGene && exportCfg.sheets.geneSummary) row('Gene Summary', 'One row per gene: curation counts, impact-passing counts, and gene-level annotations. See the column dictionary below.')
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled) row('Gene Analysis (derivation)', 'Reproducibility appendix for the samples tab: the per-tier proband DNM-burden histogram + denominators that, with a category\'s "% all genes", let you recompute every reported sample p-value exactly (Excel has no Poisson-binomial function). Only present when the data has a sample column.')
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled) row('Gene Analysis (samples) / (DNMs)', 'Convergence, in two matching tabs: which shared attributes (gnomAD constraint, ClinVar history, protein domain, GenCC inheritance; Reactome & WikiPathways pathways, HGNC gene families, MSigDB Hallmark processes, MitoCarta mitochondrial sets) your genes stack up on. Both are IGV-pass; the "(samples)" tab counts distinct probands (conservative headline), the "(DNMs)" tab counts pass DNMs. Each is a category × cumulative-impact-tier matrix of "count (%)" (with a green ✓ for FDR q<0.05, and the exact p/q to the right) against the category\'s genome-wide prevalence ("% all genes"), plus a burden-corrected Fold (observed ÷ expected, so 1× = chance). An all·ALL column flags noisy (non-pass) pools. Every tier\'s full test inputs are printed to the right so each p-value is reproducible. See the dictionary below.')
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled && exportCfg.geneAnalysis.dnmRateTest !== false) row('DNM Rate (gene-set)', 'De novo mutation-rate enrichment (Test B): whether a gene set carries more DE NOVO variants than the germline mutation rate predicts for N trios — Poisson λ = 2·N·Σp, with a live =1−POISSON(k−1,λ,TRUE) derivation. p = the per-gene per-transmission de novo rate (Samocha 2014 model, bundled from DeNovoWEST). No scale is fitted to the cohort; the per-class observed/expected ratios are reported as a model-fit diagnostic instead. De-novo-only; appears only when the data has an `inheritance` column and the rate bundle is present. Complements the origin-agnostic Gene Analysis tabs. See the Methods dictionary below.')
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled && exportCfg.geneAnalysis.dnmRateTest !== false) row('DNM Rate (per-gene)', 'The same de novo mutation-rate test at GENE level: one row per (gene, track) with an observed de novo variant, k vs Poisson λ = 2·N·p, live =1−POISSON(k−1,λ,TRUE). Nonsense+splice / missense / protein-altering are separate Benjamini-Hochberg discovery families; synonymous is the model-fit diagnostic (no discovery q). Power comes from recurrence (≥2 de novos/gene).')
    if (exportCfg.sheets.sampleSummary) row('Sample Summary', 'Per-sample variant counts by impact group and frequency threshold, with cohort mean/median.')
    if (hasSampleQc && exportCfg.sheets.sampleQc) row('Sample QC', 'Per-sample sequencing QC metrics with threshold-based pass/warn/fail assessment.')
    if (exportCfg.sheets.appliedFilters) row('Applied Filters', 'The filters and export settings used to produce this report (self-documenting).')
    if (exportCfg.sheets.annotationStatus) row('Annotation Status', 'Which external data sources were fetched, any failures, and data-source licences.')
    if (hasLollipop) row('LP <gene>', 'Lollipop plot(s): variant positions along the protein with domain overlays.')
    if (hasScreenshots) row('1, 2, 3, …', 'IGV screenshots captured for individual variants, linked from the Variants sheet.')

    // --- Gene Summary column dictionary ---
    if (hasGene && exportCfg.sheets.geneSummary) {
        section('Gene Summary — column dictionary')
        row('Gene', 'HGNC gene symbol.')
        row('Total', 'Total variants in this gene passing the applied filters.')
        row('Samples', 'Distinct samples/trios harbouring a variant in this gene.')
        row('Pass / Fail / Uncertain / Pending', 'Per-gene counts of variants by reviewer curation status.', 'Reviewer curation')
        if (hasImpact && exportCfg.impactCounts && exportCfg.impactCounts.passByImpact) {
            row('Pass HIGH / Pass MODERATE / Pass LOW / Pass ALL', 'Count of HIGH/MODERATE/LOW-impact variants in this gene that PASS review; Pass ALL = passing variants of ANY impact (incl. MODIFIER/blank), i.e. not limited to HIGH/MOD/LOW.', 'impact × curation')
        }
        if (hasImpact && exportCfg.impactCounts && exportCfg.impactCounts.totalByImpact) {
            row('HIGH / MODERATE / LOW', 'Count of HIGH/MODERATE/LOW-impact variants in this gene regardless of review status.', 'impact column')
        }
        if (ga.enabled) {
            if (ga.geneName) row('Gene Name', 'Full gene name.', 'MyGene.info', 'see below')
            if (ga.geneType) row('Gene Type', 'Gene biotype (e.g. protein-coding).', 'MyGene.info', 'see below')
            if (ga.omim) row('OMIM', 'OMIM MIM number (identifier only — link to omim.org/entry/<MIM>). OMIM disease titles are not embedded (licence).', 'OMIM via MyGene', 'ID/link only')
            if (ga.pathways) row('Pathways', 'KEGG pathway memberships.', 'MyGene.info', 'see below')
            if (ga.summary) row('Summary', 'NCBI gene function summary.', 'MyGene.info', 'see below')

            // Provider columns, described by key so the dictionary tracks what is emitted.
            const keyDesc = {
                gnomadLoeuf: ['gnomAD LoF observed/expected upper CI (LOEUF). Lower = more constrained; <0.35 flagged constrained.', 'gnomAD', 'CC0'],
                gnomadPli: ['Probability of loss-of-function intolerance (pLI). ≥0.9 = LoF-intolerant.', 'gnomAD', 'CC0'],
                gnomadConstrained: ['Derived flag: Yes if pLI≥0.9 or LOEUF<0.35.', 'gnomAD (derived)', 'CC0'],
                gnomadMisZ: ['Missense constraint Z-score. ≥3.09 = missense-constrained.', 'gnomAD', 'CC0'],
                clinvarP: ['Count of ClinVar variants classified Pathogenic for this gene (GRCh38).', 'ClinVar', 'public domain'],
                clinvarLp: ['Count of ClinVar variants classified Likely pathogenic for this gene (GRCh38).', 'ClinVar', 'public domain'],
                clinvarPlp: ['Combined count of Pathogenic + Likely-pathogenic (+ Pathogenic/Likely-pathogenic) variants.', 'ClinVar', 'public domain'],
                clinvarHasPlp: ['Yes if the gene has ≥1 Pathogenic or Likely-pathogenic variant in ClinVar.', 'ClinVar', 'public domain'],
                clinvarVus: ['Count of uncertain-significance variants in ClinVar.', 'ClinVar', 'public domain'],
                clinvarConflicts: ['Count of variants with conflicting classifications in ClinVar.', 'ClinVar', 'public domain'],
                genccMoi: ['Mode(s) of Inheritance (AD/AR/XL…) for the gene, from established-evidence GenCC submissions. AD/monoallelic ⇒ one de novo hit can be causal.', 'GenCC', 'CC0'],
                genccValidity: ['Highest gene-disease validity classification (Definitive→Refuted) across GenCC submitters.', 'GenCC', 'CC0']
            }
            for (const col of annotationRegistry.columns(exportCfg)) {
                if (keyDesc[col.key]) {
                    row(col.header, keyDesc[col.key][0], keyDesc[col.key][1], keyDesc[col.key][2])
                } else if (String(col.key).startsWith('list_')) {
                    row(col.header, 'Membership flag (Yes/No): is this gene present in the named user-supplied gene list?', 'user list', 'membership only')
                }
            }
            if (ga.mitocarta !== false && mitocarta.available().length) {
                row('Mitochondrial (MitoCarta)', 'Is the gene in the MitoCarta3.0 mitochondrial inventory? "Yes" with the sub-mitochondrial localization when known (e.g. "Yes — Matrix, MIM"), else blank. Downloaded from the Broad at runtime (not redistributed).', 'MitoCarta3.0 (Broad)', 'CC BY-NC')
            }
        }
    }

    // --- Gene Analysis dictionary ---
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled) {
        section('Gene Analysis — how to read it')
        row('Two tabs', 'Convergence is split into TWO matching tabs by the unit of interest. "Gene Analysis (samples)" counts DISTINCT PASS PROBANDS — the conservative, robust headline (a hypermutated proband counts once and can\'t fake convergence). "Gene Analysis (DNMs)" counts PASS DNMs — the variant-level companion (a proband with several hits inflates it). Same categories, same background, same layout; only the counted unit and its test differ. The samples tab is omitted when the data has no sample column.', 'samples | DNMs')
        row('Purpose', 'For each grouping dimension, shows which shared attributes (categories) your genes converge on — the signal when de novo hits are singletons scattered across genes. Everything on both tabs is IGV-PASS only.')
        row('Pass-tier cells: count (%) ✓', 'The four "pass·…" columns are CUMULATIVE impact tiers (HIGH ⊆ HIGH+MOD ⊆ HIGH+MOD+LOW ⊆ ALL; ALL includes MODIFIER/blank). Each cell = the count of the tab\'s unit (probands or DNMs) in a category gene at that tier, and in parens their % of the base (the cohort probands on the samples tab, the total pass DNMs on the DNMs tab). A green "✓" marks a tier whose FDR q<0.05. Blank = 0. Reading across the tiers shows whether the convergence is concentrated in high-impact variants or only appears once low-impact hits are included.', 'impact tier × category')
        row('“…p/q” columns (right)', 'The exact statistics behind each tier\'s ✓, kept to the right so the cells stay scannable: "p / q" = the uncorrected p-value and the Benjamini-Hochberg FDR q for that tier (green when q<0.05; "—" for an empty tier or a dimension with no background). Samples tab p: Poisson-binomial — probability of ≥ this many pass probands hitting the category by chance, where each proband\'s expected hit-rate uses its OWN pass-DNM burden at that tier (a proband with many DNMs is expected to hit, so its single hit is not surprising). DNMs tab p: binomial — each pass DNM at that tier is an independent draw at the "% all genes" rate (not deduped by proband, so less robust). Each tab\'s q is BH-corrected PER DIMENSION across its (category × tier) tests.', 'Poisson-binomial / binomial + BH')
        row('Derivation columns (DNMs tab) — EVERY tier', 'Each row prints the complete test inputs for ALL FOUR tiers, so every p-value on the tab is reproducible from the tab itself. The DNM test is a BINOMIAL: X ~ Binomial(n, p). Per tier T: k = "k DNMs (T)" = that tier\'s category pass DNMs; n = "n pass DNMs (T)" = that tier\'s pass variants INSIDE THAT ROW\'S DIMENSION\'s gene universe (each tier is tested against its own gated total — NOT the ALL total, and NOT the cohort-wide total: a dimension can only draw from the genes its source classifies); p = "p (prev)" = the category\'s prevalence ("% all genes" as a fraction), shared by all tiers because it is a gene property. RATIONALE: under the null each of the n pass DNMs independently lands in a category gene with probability p, so we ask whether MORE landed there than chance. "Expected n·p (T)" is a live formula. The upper tail P(X≥k) is written in "P(X≥k) (T)" as the live Excel formula  =1−BINOMDIST(k−1, n, p, TRUE)  and reproduces that tier\'s "p/q" column EXACTLY.', 'X ~ Binomial(n, p); P(X≥k)=1−BINOMDIST(k−1,n,p,TRUE) per tier')
        row('Derivation columns (samples tab) — EVERY tier', 'Each row prints the complete inputs for ALL FOUR tiers. The SAMPLE test is a POISSON-BINOMIAL (a binomial whose trials have DIFFERENT success probabilities): X = Σᵢ Bernoulli(pᵢ) over the at-risk probands, where proband i carrying dᵢ pass DNMs at that tier hits a category gene by chance with pᵢ = 1−(1−p)^dᵢ. Per tier T: k = "k probands (T)" = probands observed hitting; n = "n at-risk (T)" = probands with ≥1 pass variant at that tier IN THAT ROW\'S DIMENSION\'s gene universe; "Expected Σpᵢ (T)" = Σ_d n_d·[1−(1−p)^d], shown as a LIVE SUMPRODUCT over the burden histogram on the "Gene Analysis (derivation)" sheet — i.e. the expectation is derived in-cell, not asserted. RATIONALE: this dedups per proband AND credits a high-burden proband with a higher chance, so a hypermutant cannot fake convergence. IMPORTANT: Excel has no Poisson-binomial function, so "P(X≥k) approx (T)" is a LIVE BINOMIAL APPROXIMATION  =1−BINOMDIST(k−1, n, Expected/n, TRUE). By Hoeffding (1956) it is conservative (≥ the exact value) for k ≥ Expected+1, where it can run ~10% high; in the narrow band Expected < k < Expected+1 (notably k=1 rows on rare categories) it can run slightly BELOW the exact value. It is NOT the reported number and is labelled "approx". The EXACT value is the tier\'s "p/q" column; reproduce it from the "Gene Analysis (derivation)" sheet, which publishes the per-tier proband burden histogram (the test\'s only other input) plus the exact algorithm.', 'X = ΣBernoulli(pᵢ); exact = Poisson-binomial (see derivation sheet)')
        row('Gene Analysis (derivation) sheet', 'The reproducibility appendix for the sample test. Because each proband\'s pᵢ = 1−(1−p)^dᵢ depends ONLY on its DNM burden dᵢ, the per-tier BURDEN HISTOGRAM (how many probands carry each dᵢ) plus a category\'s p fully determine that category\'s exact Poisson-binomial at every tier. The sheet prints ONE BLOCK PER DIMENSION — each dimension\'s trials are gated to its own source\'s gene universe, so its histogram and its denominators are its own, and reproducing a row means using the block whose heading matches that row\'s section. Each block gives the histogram, the per-tier denominators (at-risk probands / pass variants, both gated), a self-consistency cross-check, and the exact O(n·k) convolution algorithm (plus equivalent library references) so any reader can recompute every reported sample p-value outside Excel.', 'per-dimension histogram + p ⇒ exact p-value')
        row('all·ALL', 'QUALITY FLAG (all curation statuses, any impact): the tab\'s unit hitting the category regardless of IGV status. A large gap (all·ALL ≫ pass·ALL) means the category\'s pass signal was drawn from a pool with many poor-quality/non-pass calls — treat that row with suspicion.', 'curation quality check')
        row('cat size / % all genes', 'The BACKGROUND (chance rate). Each dimension is scored against ITS OWN gene universe — the genes its source actually classifies (gnomAD scores constraint for ~17.5k genes, GenCC asserts on ~6.1k, MSigDB Hallmark annotates ~4.4k; the exact size is in each section header). cat size = the genes in that universe carrying the category; % all genes = cat size ÷ that universe. CRUCIALLY the variants counted are gated to the SAME universe (see "What each dimension can see"), so the chance rate and the trials describe the same gene set — that identity is what makes the test valid, and it is what was broken before this build. Because the universes differ, "% all genes" and Fold are comparable WITHIN a dimension, NOT across dimensions. Shows "—" (and the section says NO BACKGROUND) when a dimension has no offline background and is therefore NOT TESTED: constraint on GRCh37 exports (the tail must not mix a v4.1 background with v2.1.1 per-gene calls), or the protein domain when the InterPro bundle is absent (MyGene fallback gives terms but no background).', 'per-dimension universe')
        row('What each dimension can see', 'A dimension\'s test counts only variants in genes its own source classifies; the rest are excluded from THAT dimension (they still count on every other dimension whose source classifies the gene, and on the Variants / Gene Summary tabs). The tabs print the per-dimension count and gene symbols whenever anything was dropped. WHY this is required rather than a convenience filter: the null asks "had this proband\'s variants landed in random genes THIS SOURCE COULD HAVE CLASSIFIED, how often would one be in this category?" — a gene the source never classified could not have hit any of its categories, so counting it as a draw would inflate the trials against a chance rate it cannot meet. It also keeps "unmeasured" distinct from "not a member": gnomAD never scoring a gene does not make that gene unconstrained. CONSEQUENCE: each dimension answers a CONDITIONAL question — GenCC\'s is "among genes with a gene-disease assertion, do mine converge on this inheritance mode?", not a statement about all genes.', 'trials gated to match')
        row('Universes differ by dimension', 'This is deliberate and it is why the numbers differ between sections. Notably the gnomAD constraint universe is AUTOSOME-ONLY — gnomAD v4.1 publishes no chrX constraint at all — so an X-linked gene (DMD, MECP2, FMR1, DDX3X) cannot appear in the constraint dimension, while ClinVar, GenCC, InterPro and Reactome all classify those genes and do test them. THE BUG THIS FIXED: before this build the chance rate was already per-source, but the trials stayed genome-wide, so a category\'s share of ITS LIBRARY was tested against draws from the whole genome. Every dimension\'s expected count was therefore inflated by 1 ÷ (its coverage of the genes the variants actually land in), because draws it could never classify were still counted as trials. Simulated on these bundles (N=220, genes drawn uniformly from the 32,668 any source knows; observed ÷ expected, where 1.00 is correct): MSigDB Hallmark 0.13 at 13.4% coverage, WikiPathways 0.27 at 27.5%, Reactome 0.35 at 35.8%, HGNC families 0.48 at 47.7%, InterPro domain 0.59 at 58.6% — the reading equals the coverage, which is the fingerprint. The error was never anti-conservative; it made narrow dimensions progressively VACUOUS. On Hallmark a genuine 3× enrichment would have read 3 × 0.133 = 0.40×, i.e. apparent DEPLETION. With the trials gated every dimension calibrates to 0.98–1.00. The exact factor is cohort-dependent, so each dimension\'s own gated n is printed on the derivation sheet next to the cohort-wide totals.', 'fixed: trials now match')
        row('Fold (pass·ALL)', 'The headline effect size at the pass·ALL tier: OBSERVED ÷ EXPECTED-UNDER-THE-NULL, so 1× means "exactly what THIS NULL predicts" on BOTH tabs — and the null counts GENES, not bases (see "chance fold (gene size)"). Samples tab: # pass·ALL probands ÷ "Expected Σpᵢ (ALL)" — the Poisson-binomial mean, i.e. the SAME expectation its p-value uses, which credits each proband with its own pass-variant burden. (It is deliberately NOT probands÷cohort ÷ "% all genes": that divides a per-proband rate by a per-draw prevalence, so under the null it would drift up with the cohort\'s mean variant burden — ~3× at 3 variants/proband, ~8× at 10 — and manufacture a large "fold" on rows whose p-value is null.) DNMs tab: # pass·ALL DNMs ÷ "Expected n·p (ALL)" (≡ the DNM rate ÷ "% all genes"). Bold-green when ≥5× AND backed by ≥2 units (a big fold on a single unit / tiny cohort is left un-bolded). Because the fold and the p-value now share one expectation, they can no longer disagree.')
        row('chance fold (gene size)', 'A DIAGNOSTIC beside the Fold, and the honest caveat on this whole tab. The test above counts GENES: its null asks whether the hit genes concentrate in a category more than a RANDOM SET OF GENES would. That is the standard over-representation question and it is deliberate — the mutation-RATE question is answered separately by the DNM Rate tabs, and there is no point in both tests asking the same thing. But variants do not arrive one-per-gene; they arrive in proportion to a gene\'s mutational TARGET, so a category of large genes collects more variants BY CHANCE than its share of genes implies. This column measures exactly that, per category: the fold the category would show under a rate-aware null with NO biology at all, using the same per-gene de novo rates as Test B (Samocha 2014 / DeNovoWEST). READ IT AS A FLOOR: "Fold 3.0× · chance fold 1.5×" means roughly 2× of the 3× is real and the rest is gene size. ~1.0 means the category is length-neutral and its Fold can be read at face value. Measured on the bundled libraries: GenCC Autosomal recessive 1.01×, GenCC Unknown 0.96× (clean); ClinVar P/LP 1.27×; pLI≥0.9 1.41×; LOEUF<0.6 1.48× — the constraint categories are the biased ones because LOEUF cannot be estimated confidently on a short gene, so the constrained set runs 1.68× larger per gene. It affects the RANKING too: at equal true enrichment a length-biased category outranks a neutral one. This column changes NO p, q, Fold or sort order — it is reported so the reader can discount, never applied. Shows "—" when the rate bundle is absent.', 'diagnostic — never applied')
        row('# genes / Genes', 'Distinct PASS genes in the category (pass·ALL), and their symbols (locus heterogeneity). A category is shown only if ≥2 pass samples OR ≥2 pass genes share it; a row is bold when ≥2 pass·ALL units share it. Note: a category kept via ≥2 GENES with only 1 proband can still earn a ✓ on the samples tab — that is within-proband gene convergence, not cross-sample recurrence.')
        row('Dimensions', 'All 8 offline for an hg38 export with the bundles present: gnomAD constraint tail (LOEUF<0.6 / pLI≥0.9), ClinVar P/LP history, GenCC Mode-of-Inheritance, protein domain (InterPro, human gene→domain bundled from Ensembl/InterPro — terms + background from the same source), Reactome & WikiPathways pathways, HGNC gene families (PROTEIN-CODING genes only — non-coding loci excluded so the background is the coding genome), MSigDB Hallmark processes. Plus up to 3 MitoCarta3.0 dimensions (mitochondrial localization, sub-mitochondrial localization, MitoPathways3.0) when the runtime download from the Broad has succeeded (CC BY-NC — not bundled; absent when egress is blocked). Each dimension is scored over ITS OWN source\'s genes and its trials are gated to the same set, so each answers a question conditional on that universe — read Fold within a dimension, not across. On GRCh37/hg19 the constraint TERMS come from the live gnomAD API and the constraint BACKGROUND is withheld (mixing a v4.1 background with v2.1.1 calls would be a build error, so the dimension shows counts but no p/q); if the InterPro bundle is absent the domain TERMS fall back to live MyGene, likewise with no background.', 'up to 11 dimensions')
        row('Reading pathways', 'Pathway dimensions overlap heavily (a gene sits in many pathways), so many near-identical rows can share the same genes — only the top 25 per dimension (by pass·ALL distinct-proband count, a single ranking shared by both tabs) are shown and the remainder is noted. Judge convergence by the gene list + the counts, not by the number of rows.')
        row('Method', 'Read the Fold (observed ÷ expected) TOGETHER with its tier\'s q — they share one expectation, so a large Fold on a null q now means "few units, wide uncertainty", not a contradiction. Do not read the raw count against "% all genes" by eye: on the samples tab that comparison ignores each proband\'s variant burden and drifts upward with it (the Poisson-binomial expectation in the Fold is what corrects for that). The SAMPLE tab\'s q is the conservative statistical backstop; the DNM tab\'s q is a less-robust companion. Enrichment is upper-tail only (depletion is not tested), and FDR is controlled WITHIN each dimension (don\'t pool ✓ across dimensions); the nested pass tiers make each tier\'s q conservative. This is a GENE-COUNT (distributional) null — it is origin-agnostic (de novo or inherited) and captures ALL variant types incl. indels.' + (exportCfg.geneAnalysis.dnmRateTest !== false
            ? ' The complementary mutation-rate null lives on the separate "DNM Rate (gene-set)" tab (Test B, de novo only).'
            : ' A complementary DE NOVO MUTATION-RATE null (Test B) exists in this tool but is WITHHELD from this workbook — see the "Mutation-rate test (turned OFF for this export)" row below.'))
        if (exportCfg.geneAnalysis.dnmRateTest === false) {
            row('Mutation-rate test (turned OFF for this export)', 'This workbook contains NO de novo mutation-rate test (Test B: k ~ Poisson(λ = 2·N·Σp), where p is a per-gene per-transmission de novo rate and N the trio count). It ships ON by default; it was switched OFF for this export by an explicit `dnmRateTest: false` in the export config — this is a setting, not a defect and not an omission. HISTORY, because the reason it was once off has changed and should not be mistaken for the current one: Test B was originally withheld because λ was built from gnomAD\'s lof.mu/mis.mu/syn.mu, which are a MUTABILITY COVARIATE rather than a rate (summed they predict 0.276 coding de novo per trio against a published ~1.0–1.3, at a class balance of 0.319 vs ~0.168) — that would have pushed ~200 genes past the FDR threshold on a single variant at N=220 where correct rates give 32. That defect is FIXED: λ now uses the Samocha-2014 rates bundled from DeNovoWEST (1.074 per trio, ratio 0.161), no scale is fitted to the cohort, and a second independently-built rate table ships alongside as a cross-check. Re-enable with `dnmRateTest: true`. NOTHING on the Gene Analysis tabs depends on it — those are a gene-count null and are unaffected.', 'turned off in this export\'s config', 'Test B suppressed')
        }
        row('BH family (what q corrects for)', 'The Benjamini-Hochberg family is, per dimension, the A-PRIORI grid: EVERY category in the source library × every LIVE cumulative pass tier — the size m is printed in each section header. "Live" is the exact word: a tier with no pass variant ANYWHERE in this dimension asks no question, so it is not in the family (padding m with phantom rows would only make every real q needlessly conservative). Within a live tier, a category that no cohort gene belongs to WAS still scanned and carries its exact p = P(X≥0) = 1 — it can never be rejected, but it DOES count toward m. The display filters (the ≥2-samples-or-genes keep-rule, and the top-25-per-dimension cap) are applied AFTER the correction, so hiding a row never changes a q. This is load-bearing: letting the observed data pick the family — correcting only the cells or the categories that happened to be hit — makes q anti-conservative. Simulated real FDR at a nominal 5%: ~35% correcting over hit cells only, ~15% over hit categories only (HGNC families; ~6% Reactome), vs ~1-2% for the a-priori grid. It bites hardest on the sparse libraries (Reactome/WikiPathways/HGNC/MitoPathways), where most categories go unhit; dense dimensions (constraint, GenCC, Hallmark) were already close. Because most cells are exactly p=1 the procedure is CONSERVATIVE (~1-2% against a 5% nominal) — the price of validity under discreteness. VALIDITY: BH controls FDR under independence and under positive regression dependence (Benjamini & Yekutieli, Ann Statist 2001) — the nested tiers and the overlapping gene sets within a dimension are positively dependent, which is that case. For arbitrary dependence the stricter BY procedure would scale q by Σ(1/i).', 'BH over library-category × tier, per dimension; m in each section header')
    }

    // --- De Novo Mutation-Rate Enrichment (Test B) — publication-grade methods ---
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled && exportCfg.geneAnalysis.dnmRateTest !== false) {
        section('DNM Rate (gene-set) — de novo mutation-rate enrichment (Test B)')
        row('Purpose & scope', 'A SECOND, complementary test (its own tab) asking whether more DE NOVO variants fall in a gene set than the germline mutation rate predicts for a cohort of N trios — the classic de novo enrichment framework. DE-NOVO-ONLY: suppressed unless the data has an `inheritance` column (only `de_novo` variants are counted) and the per-gene de novo rate bundle is present. It runs on GRCh37 too: the rate table is keyed by gene symbol and carries no coordinates (if anything it is GRCh37-native, coming from the DDD study). Only the CONSTRAINT dimension is build-gated, because its terms would otherwise mix gnomAD v4.1 against the v2.1.1 the GRCh37 path uses. The Gene Analysis samples/DNMs tabs (Test A) are the origin-agnostic clustering test and are unaffected; every variant type (incl. indels) remains represented there.')
        row('Model & formula', 'For a category × cumulative PROTEIN-ALTERING tier (LoF = nonsense+splice+frameshift; LoF+missense), the observed count k of curation-pass de novo variants is modelled as Poisson with mean λ = 2·N·Σp, where N = trio count and Σp = the summed per-transmission de novo rate over the category\'s AUTOSOMAL genes with a rate (over exactly the genes counted in k). NO scale is fitted to the cohort: the rate table is used as published, which keeps λ a known constant and makes THIS test conservative against under-detection — a cohort that MISSES de novo variants gives E[k] = λ·f with f ≤ 1, so P(X≥k) is if anything too large. Two limits: it assumes the cohort only misses, so a variant MISCALLED de novo inflates k against a fixed λ and pushes the other way (the curation gate, not the model, guards that); and it is the POISSON that is protected — the scale-free test conditions on each row\'s own synonymous count and CAN over-reject if curation favours damage over synonymous, which the tab says beside it. P = P(X ≥ k) = 1 − POISSON(k−1, λ, TRUE) (a live Excel formula). Constant 2 = the two parental transmissions at risk per proband. The per-class observed/expected ratios on the tab are the model-fit DIAGNOSTIC (the synonymous one is ~selection-neutral and should sit near 1); they are reported, never folded into λ. The BH family is the dimension\'s A-PRIORI grid — every library category with a modelable rate × every coding tier, NOT just the categories carrying an observed de novo (an unhit category has k=0, hence the exact p=1). m is printed in each section header.', 'X ~ Poisson(2·N·Σp); P(X≥k)=1−POISSON(k−1,λ,TRUE)')
        row('Rates (p)', 'Per-gene, per-class, PER-TRANSMISSION de novo probabilities from the Samocha 2014 trinucleotide model, bundled from the DeNovoWEST release (data/annotations/dnm_rates.json.gz). Classes: pSyn; pMis; pNonSplice = p_all − p_syn − p_mis (nonsense + essential-splice SNVs); and frameshift, DERIVED as p_lof − pNonSplice from the table\'s own p_lof. Deriving it that way makes the LoF tier\'s Σp equal the published p_lof BY CONSTRUCTION rather than by our arithmetic happening to match theirs. The two halves are kept separate because they pair with different observed counts: pairing p_lof with an SNV-only count inflates the LoF λ by 1.85× (Σp_lof/Σp_syn = 0.299 vs Σp_nonSplice/Σp_syn = 0.161), so the frameshift half is summed ONLY when a Consequence column makes frameshift countable. Cross-checked against TWO independent implementations of the same model that publish the classes separately — denovolyzeR (Ware 2015) and denovonear on MANE Select v1.5/GRCh38: frameshift/(non+splice) reads 0.851 here vs 0.855 and 0.854 there, and both give frameshift/nonsense = 1.2500 exactly, matching Samocha 2014\'s stated frameshift assumption. LIMITATION, measured and disclosed: the model\'s frameshift rate is a FLAT PER-BP CONSTANT × CDS length — frameshift/bp takes exactly ONE value across all 19,587 genes (6.81e-10), where the context-aware nonsense+splice rate per bp takes 19,342 values spanning 54×. So the frameshift half of the LoF target (~46% of its mass) is a LENGTH PROXY carrying no sequence context: indel hotspots such as homopolymers and short tandem repeats get no credit. That is Samocha 2014\'s own simplification, shared by every implementation of it, not something this tool introduced. NOT gnomAD\'s lof.mu/mis.mu/syn.mu: those are a MUTABILITY COVARIATE, identified only up to a proportionality constant (gnomAD fits expected = mu·slope + intercept and refits the slope), and summing them predicts 0.276 coding de novo per trio against a published ~1.0–1.3. This table sums to 1.074 per trio at (non+splice)/syn = 0.161, against ~0.16–0.17 from independent implementations. The gnomAD μ columns remain elsewhere in the export as a mutability covariate — they are simply not a rate.', 'DeNovoWEST (MIT); Samocha 2014', 'MIT')
        row('Consequence mapping', 'Classes come from the VEP molecular Consequence when the data has that column: stop_gained / splice_donor_variant / splice_acceptor_variant → nonsense+splice; missense_variant → missense; synonymous_variant → synonymous. VEP orders its &-separated list most-severe-first, and the most severe MODELLED term wins. frameshift_variant → frameshift. Everything else (UTR, intron, regulatory, start/stop_lost, stop_retained, inframe insertion/deletion, and every other splice_* term — region, polypyrimidine tract, 5th base — which are intronic modifiers, not essential-splice SNVs) has no rate term and is excluded; the excluded terms are counted and listed on the tab. FRAMESHIFT IS THE ONE INDEL CLASS MODELLED: the rate table gives it a term (p_lof − p_nonsense+splice, ≈0.85× the SNV-only LoF target), so frameshift de novo indels are counted AND targeted, and the LoF tier\'s Σp equals the table\'s published p_lof exactly. Every other class is SNV-only, so a nonsense or missense call on an indel has no target and is excluded. WITHOUT a Consequence column the mapping falls back to IMPACT severity (HIGH→nonsense+splice, MODERATE→missense, LOW→synonymous), which is an APPROXIMATION and is flagged on the tab: VEP LOW is NOT synonymous — measured on a real cohort, 34% of LOW rows were splice-region/intronic. That matters because the synonymous class is the model-fit DIAGNOSTIC: contaminating it corrupts the one honest QC readout on the tab. The fallback also cannot see frameshift (IMPACT lumps it in with nonsense under HIGH), so under it the LoF tier goes SNV-only on BOTH the count and the target — less powerful, never inflated.', 'VEP Consequence (IMPACT fallback)')
        row('Inclusion / exclusion', 'Counted: curation-PASS + `inheritance==de_novo` + autosomal + a modelled consequence class + a gene with a de novo RATE FOR THAT class + SNV, EXCEPT frameshift. Frameshift is the one class the rate model gives an indel term (p_lof − pNonSplice), so frameshift de novo indels are counted AND targeted; every other class pairs with an SNV-only rate, so a nonsense or missense call on an indel has no target. Excluded (STILL analysed by Test A): indels OTHER than frameshift (inframe insertion/deletion, and any non-frameshift class called on an indel, have no rate term), chrX/Y (2·N assumes two autosomal copies; proband sex unknown), MODIFIER/non-coding (no coding rate), genes without a rate, and genes lacking a rate for the variant\'s own class (no modelable target → would inflate k without λ). Under the IMPACT fallback (no Consequence column) frameshift is not countable — IMPACT lumps it in with nonsense under HIGH — so the LoF tier goes SNV-only on BOTH the count and the target: less powerful, never inflated. Exact excluded counts print on the tab.')
        row('Cohort N', 'N = the Sample-QC trio count when a --sample-qc file is loaded (counts 0-DNM trios — the correct denominator). Without it, N falls back to distinct probands in the callset, which UNDERCOUNTS (omits 0-DNM trios) → λ too small → anti-conservative p; the tab then marks results PROVISIONAL and withholds the ✓.')
        row('Multiple testing & calibration', 'FDR q = Benjamini-Hochberg per dimension across the FULL a-priori (category × tier) grid — every library category with a modelable μ, including those with NO observed de novo (exact p=1). Correcting only across the categories that happened to be hit would let the data choose the family and push the true FDR far above nominal; the minCount display filter runs AFTER the correction, so hiding a row never changes a q. Family size m prints in each section header. ✓ = q<0.05 (withheld when N is provisional). A synonymous calibration control (observed vs 2·N·Σsyn.μ) is reported: ≈1 ⇒ complete ascertainment; a ratio a little above 1 is expected because LOW-impact over-counts true synonymous, and a provisional N inflates it further. Power comes largely from recurrence, so category singletons rarely survive FDR.')
        row('Three tests, three FDR families', 'Every row carries THREE p-values because there are three different questions, and they have SEPARATE Benjamini-Hochberg families — one correction shared across them would be three chances at the same alpha. (1) POISSON, "P(X≥k)": k ~ Poisson(λ = 2·N·Σp) — more de novo than the germline rate predicts? The only one that can see an ABSOLUTE excess; needs N and the rate table\'s absolute scale, and its obs/exp is corrupted in exact proportion by any cohort-wide artefact (a uniform 3× inflation from lenient curation or a hypermutator moves it 867→2600). (2) SCALE-FREE, "p/q (scale-free)": k ~ Binomial(k + k_syn, θ), θ = Σp/(Σp+Σp_syn) — is this category skewed toward damage relative to its OWN synonymous variants? 2·N cancels out of θ. Gene-set only: a single gene has ~0.004 expected synonymous de novo, so it degenerates to θ^k and discards gene size. (3) SHARE, "p/q (share)": k | K ~ Binomial(K, π), π = Σp ÷ Σp(exome), K = the cohort\'s own total de novo count for those classes — over-represented among the de novo we ACTUALLY SAW? Needs NO trio count and NO absolute scale, so it survives a provisional N, and its obs/exp = k/(K·π) is INVARIANT under that same 3× inflation (465.0 either way). Its price is the mirror image: a GENUINE exome-wide excess divides out too, so it reports only RELATIVE over-representation. Both (1) and (3) run per-gene as well; (3) is the only scale-free test that works there. NB the share p-value still shrinks as the cohort grows — that is more data measuring the same share, not an artefact being handled; read its obs/exp for the artefact-proof number. Method for (3): Kobren, Moldovan et al., Nat Commun 2025 (RaMeDiES), implemented from the published description — their code (GPL-3) and precomputed files (variant pathogenicity scores, several non-commercial) are NOT used.', 'Poisson + scale-free + share')
        row('References', 'Samocha et al. Nat Genet 2014;46:944 (framework + rate model); Ware et al. Curr Protoc Hum Genet 2015 (denovolyzeR); Karczewski et al. Nature 2020;581:434 & Chen et al. Nature 2024;625:92 (gnomAD rates); Benjamini & Hochberg JRSS-B 1995;57:289 (FDR).')
    }

    // --- Data sources & licensing ---
    section('Data sources & licensing')
    row('gnomAD', 'Gene constraint (pLI, LOEUF, missense Z), bundled offline from gnomAD v4 (GRCh38); live API fallback for GRCh37/hg19.', 'gnomad.broadinstitute.org', 'CC0 (attrib. requested)')
    row('ClinVar', 'Per-gene counts of Pathogenic and Likely-pathogenic variants (separately), plus VUS/conflicts, from the GRCh38 variant summary.', 'ncbi.nlm.nih.gov/clinvar', 'public domain')
    row('GenCC', 'Harmonised gene-disease validity + Mode of Inheritance (aggregates ClinGen, DDG2P, PanelApp, Orphanet). Bundled offline; highest validity + established-evidence MOIs per gene.', 'thegencc.org', 'CC0')
    // Bundled gene-set libraries (Gene Analysis convergence dimensions only).
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled) {
        try {
            for (const lib of geneSets.available()) {
                const m = lib.meta || {}
                const ver = m.version ? ` (${m.version})` : ''
                row(lib.label, `${m.source || lib.id}${ver}. Gene Analysis convergence dimension (not a per-gene column). ${m.note || ''}`.trim(),
                    m.url || '', m.license || '')
            }
        } catch (_) { /* libraries optional */ }
    }
    // MitoCarta 3.0 — CC BY-NC, NOT redistributed: downloaded from the Broad at runtime
    // (download-if-missing). Powers 3 convergence dimensions AND the per-gene
    // "Mitochondrial (MitoCarta)" Gene Summary column. Absent when egress is blocked.
    try {
        for (const lib of mitocarta.available()) {
            const m = lib.meta || {}
            // Each MitoCarta dimension keeps its own universe, and the engine gates its
            // trials to match: localization asks "mito vs not" over the screened genome;
            // sub-loc/pathways ask a WITHIN-MITO question, so both their background and
            // their trials are the annotated mito genes. That is a different question,
            // not a weaker one — which is exactly why the universes must differ.
            const uni = lib.id === 'mitoLocalization'
                ? (m.geneCount ? ` Universe = the ${m.geneCount.toLocaleString()}-gene screened genome, so "% all genes" is a share of ALL screened genes (mito ≈ 6%) and only variants in a screened gene are counted.` : '')
                : (m.geneCount ? ` Universe = the ${m.geneCount.toLocaleString()} mito genes carrying this annotation, and the trials are gated to those genes too — so this asks a WITHIN-MITO question ("given a mitochondrial gene, is it of this class?"), conditional on being mitochondrial. It is NOT comparable to the localization dimension or to the genome-scale ones, and a ✓ here is a statement about specificity among mito genes, not about the genome.` : '')
            row(lib.label, `${m.source || lib.id}. Downloaded at runtime from the Broad (not redistributed — CC BY-NC). Convergence dimension${lib.id === 'mitoLocalization' ? ' + per-gene Gene Summary annotation' : ''}.${uni} ${m.citation || ''}`.trim(),
                m.url || '', m.license || '')
        }
    } catch (_) { /* MitoCarta optional (runtime download) */ }
    row('MyGene.info', 'Gene name, type, OMIM MIM number, KEGG pathways, function summary.', 'mygene.info', 'per source')
    row('Gene-list membership', 'Yes/No membership derived from user-supplied symbol lists. Used for licence-restricted sources (e.g. COSMIC): only membership is embedded, not the licensed content.', 'user-supplied', 'membership only')

    // --- Notes ---
    section('Notes')
    row('Impact counts', 'Only HIGH, MODERATE and LOW impacts are counted; MODIFIER and blank impacts are excluded.')
    row('Best-effort annotations', 'Live annotations (gnomAD, MyGene) may be blank if a fetch failed or timed out — the Annotation Status tab records failures. Bundled data (ClinVar, gene lists) are offline.')
    row('OMIM', 'Only the numeric MIM identifier is included; OMIM disease-title text is licence-restricted and is not embedded.')

    ws.autoFilter = {from: 'A1', to: {row: 1, column: 4}}
    ws.views = [{state: 'frozen', ySplit: 1}]
}

// The two Gene Analysis tabs — same category × pass-tier matrix, one per unit.
const GA_SAMPLE_TRACK = {sheetName: 'Gene Analysis (samples)', countKey: 'individuals', qKey: 'qSample', pKey: 'pSample',
    foldKey: 'foldSampleAll', unit: 'distinct PASS probands', unitShort: 'samples', testLabel: 'sample', conservative: true}
const GA_DNM_TRACK = {sheetName: 'Gene Analysis (DNMs)', countKey: 'variants', qKey: 'qDnm', pKey: 'pDnm',
    foldKey: 'foldDnmAll', unit: 'PASS DNMs', unitShort: 'DNMs', testLabel: 'DNM', conservative: false}

/**
 * "Gene Analysis (derivation)" — the reproducibility appendix for the SAMPLE test.
 *
 * The sample test is a Poisson-binomial: X = Σᵢ Bernoulli(pᵢ) over the at-risk probands,
 * where proband i with dᵢ pass DNMs hits a category gene by chance with pᵢ = 1−(1−p)^dᵢ.
 * Because pᵢ depends ONLY on dᵢ, the whole distribution is pinned down by the BURDEN
 * HISTOGRAM (how many probands carry each dᵢ) plus the category's prevalence p. Excel has
 * no Poisson-binomial function, so without this table the reported sample p/q could not be
 * reproduced by a reader at all. Publishing it makes every tier exactly reproducible, and
 * lets the samples tab derive "Expected Σpᵢ" live via SUMPRODUCT against these cells.
 *
 * @returns {{sheetName:string, byDim:Object<string,{firstRow:number, lastRow:number, dCol:number, tierCol:Object}>}|null}
 *          One ref block PER DIMENSION (keyed by dimension id) for the live formulas —
 *          each dimension's trials are gated to its own gene universe, so each has its
 *          own histogram. null when no dimension has any burden to report.
 */
function buildGaDerivationSheet(workbook, conv, styles, passCells) {
    const {headerFill, headerFont, borderThin} = styles
    // ONE BLOCK PER DIMENSION. Each dimension draws from its own gene universe U_d, so
    // its trials — and therefore its burden histogram — are its own. A single shared
    // histogram would reproduce nobody's p-value.
    const sections = (conv.sections || []).filter(s => s.available && s.burdenHistByTier)
    const anyBurden = sections.some(s => passCells.some(c => Object.keys(s.burdenHistByTier[c.tierKey] || {}).length))
    if (!anyBurden) return null                       // no pass variants anywhere — nothing to derive

    const ws = workbook.addWorksheet('Gene Analysis (derivation)')
    const nCols = 1 + passCells.length
    const tierShort = (c) => c.label.replace('pass·', '')
    let r = 0
    // Excel does NOT auto-fit merged wrapText rows, so an explicit height is required or
    // this sheet's prose (the reproduction recipe) renders clipped to a single line.
    const totalW = 44 + 20 * passCells.length          // must track the column widths set below
    const banner = (text, font) => {
        r++; const row = ws.addRow([text]); ws.mergeCells(r, 1, r, nCols)
        row.getCell(1).font = font; row.getCell(1).alignment = {wrapText: true, vertical: 'top'}
        const lines = Math.ceil(String(text).length / Math.max(20, totalW))
        row.height = Math.min(220, Math.max(font.size >= 14 ? 20 : 14, lines * (font.size >= 14 ? 19 : 13)))
    }
    banner('Gene Analysis (derivation) — reproducing the SAMPLE test p-values', {bold: true, size: 14, color: {argb: 'FF2C3E50'}})
    banner('The "Gene Analysis (samples)" p-values are a POISSON-BINOMIAL: X = Σᵢ Bernoulli(pᵢ) over the at-risk probands, where a proband carrying dᵢ IGV-pass variants hits a category gene by chance with pᵢ = 1−(1−p)^dᵢ  (p = that category\'s prevalence). Since pᵢ depends only on dᵢ, a per-tier proband BURDEN HISTOGRAM plus the per-tier denominators are the COMPLETE input: with a category\'s p they reproduce its exact p-value at every tier. Excel has no Poisson-binomial function, so the samples tab\'s "P(X≥k) approx" columns hold a binomial approximation; the EXACT values are the "p / q" columns, reproducible from this sheet.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner('ONE TABLE PER DIMENSION, and you must use the RIGHT one. Every dimension is scored against its OWN gene universe — the genes its source actually classifies (gnomAD scores constraint for ~17.5k genes; GenCC asserts on ~6.1k; MSigDB Hallmark annotates ~4.4k) — because the null asks "had this variant landed in a random gene THIS SOURCE COULD HAVE CLASSIFIED, how often would it be in this category?". So each dimension\'s trials (its dᵢ and its n) count only variants in that universe, and its burden histogram is its own. Reading a Reactome p-value against the GenCC table will not reproduce it. Find the block whose heading matches the dimension\'s section on the tab.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner('TO REPRODUCE a category\'s exact sample p-value at a tier: (1) take p from that category\'s "p (prev)" column on the samples tab — use THAT cell, not the "% all genes" column, which is a ROUNDED display string (0.014 prints as "1%"); equivalently p = "cat size" ÷ that dimension\'s section-header universe size, both printed exactly. (2) In THIS dimension\'s histogram block below, build the proband list — n_d copies of dᵢ = d for each row. (3) Map each to pᵢ = 1−(1−p)^dᵢ. (4) Compute P(X ≥ k) for the observed k (the tier\'s "k probands" column) under the Poisson-binomial. A standard exact method is the O(n·k) convolution: start dist=[1,0,…]; for each pᵢ update dist[j] = dist[j]·(1−pᵢ) + dist[j−1]·pᵢ for j = k−1…1 and dist[0] = dist[0]·(1−pᵢ); then P(X≥k) = 1 − Σ_{j<k} dist[j]. (Equivalently: R poisbinom::ppoisbinom, or Python scipy-based implementations.) "Expected Σpᵢ" = Σ_d n_d·[1−(1−p)^d] — the samples tab computes it live by SUMPRODUCT over this dimension\'s table.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner('NOTE on q: the "p / q" columns report Benjamini-Hochberg q per DIMENSION, over that dimension\'s A-PRIORI grid: EVERY category its library defines × every tier whose test is live — NOT only the categories a variant happened to hit, and NOT only the rows printed here. An unhit category has k=0, hence the exact p=1, so it is counted in the family size rather than materialised as a row. That family size m is printed in each dimension\'s section header on the tabs, and it is the m to reproduce a q with. Because the family is fixed BEFORE any display filter, neither the ≥2-sample-or-gene keep-rule nor the top-25 cap changes any q: the hidden rows are not needed to re-derive one. Every reported p-value, by contrast, is fully reproducible from this sheet.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    r++; ws.addRow([])

    const tierCol = {}
    passCells.forEach((c, i) => { tierCol[c.tierKey] = 2 + i })
    const byDim = {}

    // --- One block per dimension --------------------------------------------
    for (const sec of sections) {
        const hist = sec.burdenHistByTier || {}
        const nProbandsByTier = sec.nProbandsByTier || {}, nDnmsByTier = sec.nDnmsByTier || {}
        const ds = [...new Set(passCells.flatMap(c => Object.keys(hist[c.tierKey] || {}).map(Number)))].sort((a, b) => a - b)
        if (!ds.length) continue                      // no pass variant fell in this universe

        banner(`${sec.label} — trials drawn from this dimension's own universe of ${sec.sourceSize.toLocaleString()} genes`,
            {bold: true, size: 11, color: {argb: 'FF2C3E50'}})
        banner(`Counts below include ONLY variants in genes this source knows about${sec.nOutsideUniverse ? `; ${sec.nOutsideUniverse.toLocaleString()} pass variant${sec.nOutsideUniverse === 1 ? '' : 's'} in ${sec.nOutsideGenes.toLocaleString()} gene${sec.nOutsideGenes === 1 ? '' : 's'} fell outside it and are excluded from THIS dimension's test` : ''}. That is why the numbers differ between dimensions — each is the trial pool matching its own "% all genes".`,
            {italic: true, size: 9, color: {argb: 'FF6B7D8D'}})

        // Table 1: this dimension's per-tier denominators.
        r++; const t1 = ws.addRow(['Per-tier denominators', ...passCells.map(tierShort)])
        t1.eachCell(cell => { cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin; cell.alignment = {horizontal: 'center', wrapText: true} })
        r++; const rowAt = ws.addRow(['n (at-risk probands, ≥1 pass variant in this universe)', ...passCells.map(c => nProbandsByTier[c.tierKey] || 0)])
        r++; const rowDn = ws.addRow(['n (pass variants in this universe)', ...passCells.map(c => nDnmsByTier[c.tierKey] || 0)])
        for (const row of [rowAt, rowDn]) row.eachCell(cell => { cell.border = borderThin; cell.alignment = {horizontal: 'center'} })
        rowAt.getCell(1).alignment = {horizontal: 'left'}; rowDn.getCell(1).alignment = {horizontal: 'left'}

        // Table 2: this dimension's burden histogram (the Poisson-binomial's full input).
        r++; const t2 = ws.addRow(['dᵢ = pass variants per proband', ...passCells.map(c => `# probands (${tierShort(c)})`)])
        t2.eachCell(cell => { cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin; cell.alignment = {horizontal: 'center', wrapText: true} })
        t2.height = 26
        const firstRow = r + 1
        for (const d of ds) {
            r++
            const row = ws.addRow([d, ...passCells.map(c => (hist[c.tierKey] || {})[d] || 0)])
            row.eachCell(cell => { cell.border = borderThin; cell.alignment = {horizontal: 'center'} })
        }
        const lastRow = r
        // Cross-check row: the histogram must re-sum to the denominators above.
        r++
        const chk = ws.addRow(['Σ (cross-check: probands = n at-risk;  Σ dᵢ·n_d = n pass variants)',
            ...passCells.map((c, i) => {
                const col = colLetterOf(2 + i)
                return {formula: `SUM(${col}${firstRow}:${col}${lastRow})&" / "&SUMPRODUCT($A$${firstRow}:$A$${lastRow},${col}${firstRow}:${col}${lastRow})`,
                    result: `${nProbandsByTier[c.tierKey] || 0} / ${nDnmsByTier[c.tierKey] || 0}`}
            })])
        chk.eachCell(cell => { cell.border = borderThin; cell.font = {italic: true, size: 9, color: {argb: 'FF6B7D8D'}}; cell.alignment = {horizontal: 'center'} })
        chk.getCell(1).alignment = {horizontal: 'left'}
        r++; ws.addRow([])

        byDim[sec.id] = {firstRow, lastRow, dCol: 1, tierCol}
    }

    ws.getColumn(1).width = 48
    for (let i = 0; i < passCells.length; i++) ws.getColumn(2 + i).width = 20
    if (!Object.keys(byDim).length) return null
    return {sheetName: 'Gene Analysis (derivation)', byDim}
}

/** A1-style column letter (module-scope so the derivation sheet can use it too). */
function colLetterOf(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }

/**
 * Build one Gene Analysis tab: a category × pass-impact-tier matrix in ONE unit
 * (probands or DNMs). Each pass-tier cell = "count (FDR q)". `conv` is the output
 * of computeConvergence(); `track` is GA_SAMPLE_TRACK or GA_DNM_TRACK. Wrapped by
 * the caller in try/catch — must never break the export.
 * @param {Object|null} [derivRefs] ref block from buildGaDerivationSheet. Only meaningful
 *   for the conservative (samples) track; omitted for GA_DNM_TRACK and null when the
 *   derivation sheet could not be built — in which case "Expected Σpᵢ" degrades from a
 *   live SUMPRODUCT to the plain (asserted) number.
 */
function buildGeneAnalysisTab(workbook, conv, styles, track, derivRefs) {
    const {headerFill, headerFont, borderThin} = styles
    const ws = workbook.addWorksheet(track.sheetName)
    const passCells = conv.cells.filter(c => c.statusKey === 'pass')   // the 4 pass impact tiers, in order
    const totalProbands = conv.totalProbands || 0
    const probandsWithVariant = conv.probandsWithVariant || totalProbands
    const nPassDnms = conv.nPassDnms || 0
    // Columns: Category | 4 pass-tier "count (%) ✓" | all·ALL | # genes | cat size |
    // % all genes | Fold | 4 pass-tier "p / q" | derivation | Genes.
    // DERIVATION is per-tier so EVERY tier's p-value is reproducible from printed inputs
    // (not just pass·ALL): one shared "p (prev)" column, then 4 columns per tier
    // (k, n, Expected, P(X≥k)). Column count is deliberately traded for reproducibility.
    const base = 1 + passCells.length
    const ALLALL = base + 1, CG = base + 2, CAT = base + 3, PALL = base + 4, FOLD = base + 5
    // LBASE — the length-bias DIAGNOSTIC. Reported, never used: no p, q, fold or sort
    // touches it. The test stays a gene-count null on purpose (that is the
    // over-representation question; the mutation-rate question is Test B's).
    const LBASE = base + 6
    const PQ0 = base + 7                          // first per-tier "p / q" column
    const DER0 = PQ0 + passCells.length          // derivation block: the shared "p (prev)"
    const DERW = 4                                // columns per tier: k, n, Expected, P(X≥k)
    const derCol = (tierIdx, j) => DER0 + 1 + tierIdx * DERW + j
    const nDeriv = 1 + passCells.length * DERW
    const GENES = DER0 + nDeriv
    const nCols = GENES

    // % base for the count cells: cohort probands (samples) or total pass DNMs (DNMs).
    const pctBase = track.conservative ? totalProbands : nPassDnms
    // (No cohort-wide per-tier n is bound here on purpose. Every test input is a
    // PER-DIMENSION quantity — sec.nDnmsByTier / sec.nProbandsByTier — because each
    // dimension's trials are gated to its own source's gene universe. conv.nDnmsByTier
    // is cohort-wide and descriptive; binding it here is what previously let the
    // banner print a denominator no row held and no p-value used.)

    // A1-style column reference (for the live Excel formulas below).
    const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }
    // Derivation-cell number formats — conditional so a tiny value renders in scientific
    // notation instead of rounding to "0.0" (Excel: [<x]fmtA;fmtB → fmtA when value<x).
    const FMT_PVAL = '[<0.001]0.0E+00;0.000'     // P(X≥k): scientific when tiny, else 3 dp
    const FMT_PREV = '[<0.001]0.0E+00;0.0000'    // p (prevalence)
    const FMT_EXP = '[<0.05]0.0E+00;0.0'         // Expected count — never collapse to 0.0

    // "Expected Σpᵢ" derived LIVE from the published burden histogram:
    //   Σpᵢ = Σ_d n_d·[1−(1−p)^d]  ⇒  SUMPRODUCT(counts_d, 1-(1-p)^d)
    // so the cell shows its own derivation rather than an asserted number. Falls back to
    // the plain value when there is no derivation sheet to point at.
    // The block is chosen BY DIMENSION: each dimension's trials come from its own gene
    // universe, so pointing a row at another dimension's histogram would compute an
    // expectation that belongs to nobody. No block for this dimension ⇒ plain value.
    const sumProdExpected = (dimId, tierKey, pAddr, E) => {
        if (E == null) return '—'
        const ref = derivRefs && derivRefs.byDim && derivRefs.byDim[dimId]
        if (!ref || ref.tierCol[tierKey] == null) return E
        const q = `'${derivRefs.sheetName}'!`
        const dC = colLetter(ref.dCol), cC = colLetter(ref.tierCol[tierKey])
        const dR = `${q}$${dC}$${ref.firstRow}:$${dC}$${ref.lastRow}`
        const cR = `${q}$${cC}$${ref.firstRow}:$${cC}$${ref.lastRow}`
        return {formula: `SUMPRODUCT(${cR},1-(1-${pAddr})^${dR})`, result: E}
    }

    const fmtP = (p) => p == null ? '—' : (p < 0.001 ? p.toExponential(1) : p.toFixed(3))
    const pct = (x) => { if (x == null) return '—'; const v = x * 100; return `${v.toFixed(v < 0.1 ? 2 : (v < 1 ? 1 : 0))}%` }
    const fmtFold = (f) => f == null ? '—' : (f >= 10 ? `${Math.round(f)}×` : `${f.toFixed(1)}×`)
    const cnt = (cc) => (cc && cc[track.countKey]) || 0
    const isSig = (cc) => cc && cc[track.qKey] != null && cc[track.qKey] < 0.05
    // A pass-tier cell: "count (% of the base)" + a green ✓ when FDR q<0.05; blank for 0.
    const tierStr = (cc) => { const n = cnt(cc); if (!n) return ''; const p = pctBase > 0 ? pct(n / pctBase) : '—'; return isSig(cc) ? `${n} (${p}) ✓` : `${n} (${p})` }
    // The exact stats, off to the right: uncorrected p / FDR q for that tier.
    const pqStr = (cc) => { if (!cc) return '—'; const p = cc[track.pKey], q = cc[track.qKey]; return (p == null && q == null) ? '—' : `${fmtP(p)} / ${fmtP(q)}` }
    const MAX_GROUPS_PER_DIM = 25

    const mergeAcross = (rowIdx) => ws.mergeCells(rowIdx, 1, rowIdx, nCols)
    let r = 0
    const addBanner = (text, font) => { r++; const row = ws.addRow([text]); mergeAcross(r); row.getCell(1).font = font; row.getCell(1).alignment = {wrapText: true, vertical: 'top'}; return row }

    addBanner(`Gene Analysis — ${track.conservative ? 'SAMPLE' : 'DNM'} convergence (IGV-pass)`, {bold: true, size: 14, color: {argb: 'FF2C3E50'}})
    addBanner(`Rows = categories your genes converge on. The four pass columns are CUMULATIVE impact tiers (HIGH ⊆ HIGH+MOD ⊆ HIGH+MOD+LOW ⊆ ALL); each shows the # of ${track.unit} in a category gene and, in parens, their % of ${track.conservative ? `the ${totalProbands} cohort probands` : `the ${nPassDnms} pass DNMs`} (a share of the counted base — NOT the "% all genes" column, which is the genome background). A green "✓" marks a tier whose Benjamini-Hochberg FDR q<0.05 (its ${track.conservative ? 'conservative sample' : 'DNM'} test); the exact "p / q" per tier are in the columns to the right.${track.conservative ? '' : ' Each tier\'s p/q is computed against that tier\'s OWN pass-DNM total, not the ALL-tier total shown in the "(%)", so a non-ALL cell can be significant at a small displayed %.'} Only categories with ≥2 pass samples OR genes are listed.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    addBanner(`"% all genes" = the category's share of ITS DIMENSION's gene universe (cat size ÷ the section-header universe size) — the chance rate. Each dimension is scored over the genes its own source classifies, and its trials count ONLY variants in those genes, so the chance rate and the trials describe the SAME gene set. The universes differ (gnomAD constraint ~17.5k and autosome-only; GenCC ~6.1k; Hallmark ~4.4k), so compare Fold WITHIN a dimension, not across dimensions. "Fold (pass·ALL)" = OBSERVED ÷ EXPECTED under the null — ${track.conservative ? `pass·ALL probands ÷ "Expected Σpᵢ (ALL)", the Poisson-binomial mean that already credits each proband with its OWN variant burden (cohort ${totalProbands} probands incl. 0-variant trios; ${probandsWithVariant} carry ≥1)` : `pass·ALL variants ÷ "Expected n·p (ALL)", where n is THIS dimension's GATED pass·ALL count — the row's own "n pass DNMs (ALL)" column, NOT the cohort's ${nPassDnms}, which counts variants in genes this dimension's source never classified`} — so 1× = exactly chance, and the Fold and the p/q on a row cannot disagree. "all·ALL" = ${track.unitShort} hitting the category at ANY curation status — a large gap vs pass·ALL flags a category drawn from a noisy (poor-quality) pool.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    // Each dimension drops the variants its own source cannot classify. That is required
    // (they are not draws from that dimension's null) but it must never be silent — a
    // reader has to be able to tell whether a dimension saw their variant of interest.
    const dropped = (conv.sections || []).filter(s => s.available && s.nOutsideUniverse > 0)
    if (dropped.length) {
        addBanner(`GENES A DIMENSION CANNOT SEE: each dimension is scored only over the genes its own source classifies, and pass variants outside that set are excluded from THAT dimension's test (they still count on every other dimension whose source classifies the gene, and on the Variants / Gene Summary tabs). This is required rather than a convenience filter: a source that never classified a gene could not have placed it in any category, so counting it as a draw would inflate the trials against a chance rate it can never meet. Per dimension — ${dropped.map(s => `${s.label}: ${s.nOutsideUniverse.toLocaleString()} variant${s.nOutsideUniverse === 1 ? '' : 's'} in ${s.nOutsideGenes.toLocaleString()} gene${s.nOutsideGenes === 1 ? '' : 's'}${s.outsideGenesSample.length ? ` (${s.outsideGenesSample.slice(0, 8).join(', ')}${s.nOutsideGenes > 8 ? ', …' : ''})` : ''}`).join('  ·  ')}.`,
            {italic: true, size: 10, color: {argb: 'FFB9770E'}})
    }
    addBanner(`Green cues: a "✓" cell = FDR q<0.05 (its column has the p/q); a bold "Fold" = ≥5× AND backed by ≥2 ${track.unitShort} — a big Fold on a single ${track.unitShort} or a tiny cohort is deliberately left un-bolded, so read Fold with the cohort/count in mind. FDR is controlled WITHIN each dimension only — do not pool ✓ across dimensions.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    addBanner(track.conservative
        ? 'The SAMPLE test is the conservative, robust read: its expected accounts for EACH proband\'s per-tier pass-DNM burden, so a single hypermutated proband can\'t fake convergence (it dedups to one sample AND is expected to hit). A category kept via ≥2 GENES can still show a ✓ on a count of 1 — that is ONE proband hitting ≥2 genes that share the term (within-proband gene convergence), not recurrence across samples; check the "# genes" column. A gene-count null only approximates the de-novo mutation-rate null, so treat marginal q gently. The companion "Gene Analysis (DNMs)" tab gives the variant-level view.'
        : 'The DNM test is a binomial over pass DNMs at each tier — LESS robust than the samples tab (a hypermutated proband inflates it; it is not deduped by proband). Enrichment is upper-tail only (depletion is not tested). Use "Gene Analysis (samples)" as the headline and this for the variant-level view.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    // Derivation columns (right of Genes' left neighbour): show the exact test inputs
    // for the pass·ALL tier + a LIVE Excel formula so the p-value is fully reproducible.
    // NOTE: n is a PER-DIMENSION quantity now (each dimension's trials are gated to its
    // own source's gene universe), so there is no single cohort n this banner could
    // honestly print. It used to print conv.nDnmsByTier / conv.nProbandsByTier — the
    // cohort-wide totals — which would now contradict the n on every row and, worse,
    // point a reader at the pre-fix denominator and hand them a vacuous p-value.
    addBanner(track.conservative
        ? 'Per-row DERIVATION — printed for EVERY tier (not just pass·ALL), so each tier\'s test is reproducible from this sheet. The SAMPLE test is a Poisson-binomial: each at-risk proband i with dᵢ pass variants hits a category gene by chance with pᵢ = 1−(1−p)^dᵢ (p = the shared "p (prev)" column = "% all genes" as a fraction). Per tier: "k probands" = probands observed hitting; "n at-risk" = probands with ≥1 pass variant at that tier IN THIS DIMENSION\'S GENE UNIVERSE; "Expected Σpᵢ" = Σ_d n_d·[1−(1−p)^d], shown as a LIVE SUMPRODUCT over that dimension\'s burden histogram on the "Gene Analysis (derivation)" sheet. n IS PER-DIMENSION — each dimension is scored only over the genes its own source classifies, so there is no single cohort n: use the row\'s own "n at-risk (T)" column and the derivation block matching that dimension. Excel has NO Poisson-binomial function, so "P(X≥k) approx" is a LIVE binomial approximation  =1−BINOMDIST(k−1, n, Expected/n, TRUE)  — by Hoeffding (1956) it is CONSERVATIVE (≥ the exact value) for k ≥ Expected+1; in the narrow band Expected < k < Expected+1 (notably k=1 rows on rare categories) it can run slightly BELOW the exact value. Either way it is NOT the reported number — it is labelled "approx". The EXACT Poisson-binomial is always the "p/q" column.'
        : 'Per-row DERIVATION — printed for EVERY tier (not just pass·ALL), so each tier\'s test is reproducible from this sheet. The DNM test is Binomial(n, p): each pass variant independently lands in a category gene with p = the shared "p (prev)" column ("% all genes" as a fraction). Per tier: "k DNMs" = that tier\'s category pass variants; "n pass DNMs" = that tier\'s pass variants INSIDE THIS DIMENSION\'S GENE UNIVERSE (tested against its own gated total — not the ALL-tier total, and not the cohort-wide total); "Expected n·p" = the chance mean (live). n IS PER-DIMENSION — each dimension is scored only over the genes its own source classifies, so there is no single cohort n: use the row\'s own "n pass DNMs (T)" column. "P(X≥k)" is a LIVE Excel formula  =1−BINOMDIST(k−1, n, p, TRUE)  that reproduces that tier\'s "p/q" p-value EXACTLY.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})

    // Headline: strongest pass·ALL convergence per dimension (in this unit).
    const headBits = []
    for (const sec of conv.sections) {
        if (!sec.groups.length) continue
        const n = cnt(sec.groups[0].cells['pass|ALL'])
        if (n >= 2) headBits.push(`${sec.label}: ${n} ${track.unitShort} share "${sec.groups[0].term}"`)
    }
    addBanner(headBits.length ? `Top pass convergence — ${headBits.join(';  ')}` : `No category has ≥2 pass ${track.unitShort} yet.`,
        {bold: true, size: 11, color: {argb: 'FF2C3E50'}})
    r++; ws.addRow([])   // spacer

    // Per-tier derivation headers. The tier suffix keeps every label UNIQUE — the sheet
    // is read by column NAME (by users and by our tests), so reusing "k (probands)"
    // across tiers would silently resolve to whichever tier came first.
    const derivHeaders = ['p (prev)']
    for (const c of passCells) {
        const t = c.label.replace('pass·', '')
        derivHeaders.push(
            track.conservative ? `k probands (${t})` : `k DNMs (${t})`,
            track.conservative ? `n at-risk (${t})` : `n pass DNMs (${t})`,
            track.conservative ? `Expected Σpᵢ (${t})` : `Expected n·p (${t})`,
            track.conservative ? `P(X≥k) approx (${t})` : `P(X≥k) (${t})`)
    }
    const headerLabels = ['Category', ...passCells.map(c => c.label), 'all·ALL', '# genes', 'cat size', '% all genes', 'Fold (pass·ALL)',
        'chance fold (gene size)',
        ...passCells.map(c => `${c.label.replace('pass·', '')} p/q`), ...derivHeaders, 'Genes']
    r++
    const hdr = ws.addRow(headerLabels)
    hdr.eachCell(cell => { cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin; cell.alignment = {vertical: 'middle', horizontal: 'center', wrapText: true} })
    hdr.height = 26
    const headerRowIdx = r
    ws.getColumn(1).width = 34
    for (let i = 0; i < passCells.length; i++) ws.getColumn(2 + i).width = 15
    ws.getColumn(ALLALL).width = 8; ws.getColumn(CG).width = 8; ws.getColumn(CAT).width = 8; ws.getColumn(LBASE).width = 13
    ws.getColumn(PALL).width = 11; ws.getColumn(FOLD).width = 12
    for (let i = 0; i < passCells.length; i++) ws.getColumn(PQ0 + i).width = 13
    for (let i = 0; i < nDeriv; i++) ws.getColumn(DER0 + i).width = 12
    ws.getColumn(GENES).width = 48

    let anyGroups = false
    for (const sec of conv.sections) {
        if (!sec.groups.length) continue
        anyGroups = true
        r++
        const hiddenCount = Math.max(0, sec.groups.length - MAX_GROUPS_PER_DIM)
        const shown = sec.groups.slice(0, MAX_GROUPS_PER_DIM)
        // THIS dimension's universe: the ÷ of "% all genes" AND the gate on its trials.
        // It differs between sections by design, so it is printed on every one.
        const srcNote = sec.sourceSize ? `  ·  universe = ${sec.sourceSize.toLocaleString()} genes (÷ for "% all genes"; trials gated to these genes)` : '  ·  NO BACKGROUND — not tested (no prevalence / p / q)'
        const capNote = hiddenCount ? `   (top ${shown.length} of ${sec.groups.length})` : ''
        // BH family size m for THIS dimension + track — q is a family-wide quantity, so
        // printing m is what lets a reader audit any q (see the derivation sheet's note).
        const m = track.conservative ? sec.mSample : sec.mDnm
        const mNote = m != null ? `  ·  BH family m=${m} (category × tier tests with a p-value)` : ''
        const secRow = ws.addRow([`${sec.label}${capNote}${srcNote}${mNote}`])
        mergeAcross(r)
        secRow.getCell(1).font = {bold: true, color: {argb: 'FF2C3E50'}}
        for (let c = 1; c <= nCols; c++) secRow.getCell(c).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFD6EAF8'}}
        secRow.getCell(1).border = borderThin

        shown.forEach((g, idx) => {
            const rowNum = r + 1                                     // this row's 1-based index (for formula refs)
            const genesStr = g.genes.length > 16 ? g.genes.slice(0, 16).join(', ') + ` +${g.genes.length - 16}` : g.genes.join(', ')
            const rowVals = [g.term]
            for (const c of passCells) rowVals.push(tierStr(g.cells[c.key]))   // count (%) ✓
            rowVals.push(cnt(g.cells['all|ALL']) || '')              // all·ALL (quality flag)
            rowVals.push(g.refGenes)                                 // # genes (pass)
            rowVals.push(g.catSize != null ? g.catSize : '—')        // cat size
            rowVals.push(pct(g.prevalence))                          // % all genes
            rowVals.push(fmtFold(g[track.foldKey]))                  // Fold (pass·ALL)
            // The length-bias diagnostic, beside the Fold it qualifies. "—" when no rate
            // table is loaded; ~1.0 means the category is length-neutral and its Fold can be
            // read at face value.
            rowVals.push(g.lengthBaseline != null ? `${g.lengthBaseline.toFixed(2)}×` : '—')
            for (const c of passCells) rowVals.push(pqStr(g.cells[c.key]))   // p / q per tier (right)
            // Derivation, PER TIER: the exact inputs + LIVE Excel formulas, so every
            // tier's p-value is reproducible from what is printed — not just pass·ALL.
            if (g.prevalence == null) {
                for (let i = 0; i < nDeriv; i++) rowVals.push('—')
            } else {
                rowVals.push(g.prevalence)                          // shared p (prev)
                const pA = '$' + colLetter(DER0) + rowNum
                passCells.forEach((c, ti) => {
                    const cc = g.cells[c.key] || {}
                    const k = cnt(cc)
                    // n is THIS DIMENSION's gated trial count — the pool its p-value was
                    // actually computed against. The cohort-wide totals in the banner are
                    // larger; printing those here would make the row irreproducible.
                    const n = (track.conservative ? (sec.nProbandsByTier || {})[c.tierKey] : (sec.nDnmsByTier || {})[c.tierKey]) || 0
                    const kA = colLetter(derCol(ti, 0)) + rowNum, nA = colLetter(derCol(ti, 1)) + rowNum
                    const eA = colLetter(derCol(ti, 2)) + rowNum
                    rowVals.push(k, n)
                    if (track.conservative) {
                        // Expected Σpᵢ = Σ_d n_d·[1−(1−p)^d] — derived LIVE by SUMPRODUCT over
                        // this dimension's published burden histogram, not just asserted.
                        const E = cc.expSample
                        rowVals.push(sumProdExpected(sec.id, c.tierKey, pA, E))
                        // Excel has no Poisson-binomial ⇒ this is an explicit binomial
                        // APPROXIMATION (header says so). The exact value is the p/q column;
                        // reproduce it from the derivation sheet's histogram.
                        rowVals.push((n > 0 && E != null && k > 0)
                            ? {formula: `1-BINOMDIST(${kA}-1,${nA},${eA}/${nA},TRUE)`, result: binomUpperTail(k, n, E / n)}
                            : '—')
                    } else {
                        // result comes from the engine (cc.expDnm) so the sheet and the
                        // test share one source of truth; 0-prevalence rows fall back to 0.
                        rowVals.push({formula: `${nA}*${pA}`, result: cc.expDnm != null ? cc.expDnm : n * g.prevalence})
                        // Exact: reproduces this tier's "p/q" p-value to the last digit.
                        rowVals.push((k > 0 && n > 0)
                            ? {formula: `1-BINOMDIST(${kA}-1,${nA},${pA},TRUE)`, result: cc.pDnm}
                            : '—')
                    }
                })
            }
            rowVals.push(genesStr)
            r++
            const row = ws.addRow(rowVals)
            row.eachCell(cell => { cell.border = borderThin; if (idx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}} })
            for (let i = 0; i < passCells.length; i++) row.getCell(2 + i).alignment = {horizontal: 'center'}
            for (const col of [ALLALL, CG, CAT, PALL, FOLD]) row.getCell(col).alignment = {horizontal: 'center'}
            for (let i = 0; i < passCells.length; i++) row.getCell(PQ0 + i).alignment = {horizontal: 'center'}
            for (let i = 0; i < nDeriv; i++) row.getCell(DER0 + i).alignment = {horizontal: 'center'}
            // Magnitude-preserving formats: switch to scientific for tiny values so a
            // small prevalence / expected count / p-value never collapses to "0.0".
            if (g.prevalence != null) {
                row.getCell(DER0).numFmt = FMT_PREV                                  // shared p (prev)
                passCells.forEach((c, ti) => {
                    row.getCell(derCol(ti, 2)).numFmt = FMT_EXP                      // Expected
                    row.getCell(derCol(ti, 3)).numFmt = FMT_PVAL                     // P(X≥k)
                })
            }
            passCells.forEach((c, i) => {
                if (!isSig(g.cells[c.key])) return
                row.getCell(2 + i).font = {bold: true, color: {argb: 'FF1E8449'}}      // green count cell
                row.getCell(PQ0 + i).font = {bold: true, color: {argb: 'FF1E8449'}}    // green p / q cell
            })
            // Bold-green Fold only when it's both large AND backed by ≥2 units — a
            // striking fold on a single unit / tiny cohort is left un-bolded.
            if (g[track.foldKey] != null && g[track.foldKey] >= 5 && cnt(g.cells['pass|ALL']) >= 2) row.getCell(FOLD).font = {bold: true, color: {argb: 'FF1E8449'}}
            if (cnt(g.cells['pass|ALL']) >= 2) row.getCell(1).font = {bold: true}
        })

        if (hiddenCount) {
            r++
            const noteRow = ws.addRow([`… ${hiddenCount} more categor${hiddenCount === 1 ? 'y' : 'ies'} not shown (overlapping categories with the same genes; ranked below the top ${MAX_GROUPS_PER_DIM}).`])
            mergeAcross(r)
            noteRow.getCell(1).font = {italic: true, size: 9, color: {argb: 'FF6B7D8D'}}
        }
    }

    if (!anyGroups) { r++; ws.addRow([`No convergence found — no category is shared by ≥2 IGV-pass ${track.unitShort} or genes in the current export.`]); mergeAcross(r) }

    ws.views = [{state: 'frozen', ySplit: headerRowIdx}]
}

/**
 * "DNM Rate (gene-set)" tab — the de novo mutation-rate enrichment (Test B).
 * Category × cumulative coding tier: observed k pass de novo variants vs a Poisson null
 * λ = 2·N·Σp, with a live =1-POISSON(k-1, λ, TRUE) derivation. Publication-grade:
 * the banner carries the full method, inputs, exclusions, and synonymous calibration.
 * `dnm` = computeModelEnrichment() output. Wrapped by the caller in try/catch.
 */
function buildDnmRateCategoryTab(workbook, dnm, styles) {
    const {headerFill, headerFont, borderThin} = styles
    const ws = workbook.addWorksheet('DNM Rate (gene-set)')
    const meta = dnm.meta, sections = dnm.perCategory.sections, tiers = dnm.perCategory.tiers
    const N = meta.N || 0, reliable = !!meta.nReliable
    const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }
    const FMT_PVAL = '[<0.001]0.0E+00;0.000', FMT_MU = '0.00E+00', FMT_LAM = '[<0.05]0.0E+00;0.000'
    const fmtP = (p) => p == null ? '—' : (p < 0.001 ? p.toExponential(1) : p.toFixed(3))
    const fmtR = (x) => x == null ? '—' : x.toFixed(2)
    // ✓ = Poisson q<0.05, gated on a defensible N. λ = 2·N·Σp uses N directly (there is no
    // fitted scale for it to cancel against), so a provisional N really does shrink λ and
    // really does make the p anti-conservative — that gate is meaningful again.
    // The Poisson is CONSERVATIVE against UNDER-DETECTION here: a cohort that only MISSES de
    // novo variants gives E[k] = λ·f with f ≤ 1. It is NOT unconditionally conservative — a
    // variant miscalled de novo inflates k against a fixed λ — and the guarantee is the
    // Poisson's alone; the conditional tests beside it can over-reject on class-skewed curation. Measured 0.81× of nominal at f=1 and lower as f
    // falls; curation skew cannot inflate it, because the synonymous count is not in λ.
    const poissonValid = reliable
    const isSig = (cc) => poissonValid && cc && cc.q != null && cc.q < 0.05
    const kStr = (cc) => { if (!cc || !cc.k) return ''; return isSig(cc) ? `${cc.k} ✓` : `${cc.k}` }
    const pqStr = (cc) => { if (!cc || cc.p == null) return '—'; return `${fmtP(cc.p)} / ${fmtP(cc.q)}` }
    // The scale-free companion, printed for every row but NEVER driving ✓. It answers a
    // different question — "is this category SKEWED toward damage relative to its own
    // synonymous variants?" — and it is the WEAKER of the two against the hazard that
    // actually threatens this data: because it compares damaging against synonymous, a
    // class-skewed curation pass rate moves θ and it over-rejects, while the Poisson merely
    // loses power. Its value is that it is immune to the rate table's absolute scale.
    const condStr = (cc) => { if (!cc || cc.pCond == null) return '—'; return `${fmtP(cc.pCond)} / ${fmtP(cc.qCond)}` }
    // The cohort-conditioned test: k | K ~ Binomial(K, π). Its own family, its own column.
    const shareStr = (cc) => { if (!cc || cc.pShare == null) return '—'; return `${fmtP(cc.pShare)} / ${fmtP(cc.qShare)}` }
    const MAX_GROUPS_PER_DIM = 25

    // Columns: Category | tier "k ✓" | # genes | # probands | tier "p/q" (Poisson) |
    //          tier "p/q" (scale-free) | k | k_syn | Σp | Σp_syn | θ | λ | P(X≥k)
    //          [| λ (cross-check) | λ ratio]  | Genes
    // nAlt is 0 or 2 and EVERY constant downstream of λ is derived from it — the cross-check
    // columns are inserted, not appended, so a hardcoded index here would silently write the
    // gene list into the ratio column.
    const T0 = 2, nT = tiers.length
    const nAlt = meta.altTable ? 2 : 0
    const CG = 1 + nT + 1, CP = CG + 1, PQ0 = CP + 1
    const CQ0 = PQ0 + nT                                   // scale-free p/q, one per tier
    const SQ0 = CQ0 + nT                                   // cohort-conditioned p/q, one per tier
    const DK = SQ0 + nT, DKS = DK + 1, DMU = DKS + 1, DMUS = DMU + 1, DTH = DMUS + 1
    const DLAM = DTH + 1, DP = DLAM + 1
    const SK = DP + 1, SPI = SK + 1, SEXP = SPI + 1, SP = SEXP + 1   // share derivation
    const DLAMALT = nAlt ? SP + 1 : null, DRATIO = nAlt ? SP + 2 : null
    const GENES = SP + nAlt + 1
    const nCols = GENES
    const headTier = tiers[nT - 1]           // the broadest coding tier = the derivation worked example

    const mergeAcross = (r) => ws.mergeCells(r, 1, r, nCols)
    let r = 0
    const banner = (text, font) => { r++; const row = ws.addRow([text]); mergeAcross(r); row.getCell(1).font = font; row.getCell(1).alignment = {wrapText: true, vertical: 'top'}; return row }

    banner('Gene Analysis — DE NOVO MUTATION-RATE enrichment (Test B)', {bold: true, size: 14, color: {argb: 'FF2C3E50'}})
    banner(`This is the DE-NOVO-ONLY, mutation-rate test — distinct from the origin-agnostic "Gene Analysis (samples/DNMs)" tabs (Test A). Model: the # of de novo variants in a category is Poisson with mean λ = 2·N·Σp, N = ${N} trios (${reliable ? 'Sample-QC trio count, includes 0-DNM trios' : 'PROVISIONAL — no Sample-QC file, N is a lower bound'}), p = the per-gene per-transmission de novo rate (Samocha 2014 trinucleotide model, from ${meta.rateTable ? meta.rateTable.label : 'the bundled rate table'}${meta.rateTable && meta.rateTable.transcripts ? '; ' + meta.rateTable.transcripts : ''}). NO scale is fitted to this cohort — see below for why, and for how to read the model-fit ratios. Classes: LoF (nonsense + essential-splice SNVs${meta.countFrameshift ? ' + frameshift indels' : ''}) and missense; the two columns are CUMULATIVE PROTEIN-ALTERING tiers. Synonymous is the CALIBRATOR, never a discovery column. Each cell = # observed de novo variants; ✓ = Benjamini-Hochberg FDR q<0.05 (per dimension).`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner(`Derivation (worked for the ${headTier.label} tier): "k" = observed de novo variants (SNVs, plus frameshift indels when a Consequence column makes frameshift countable — the one indel class the rate model targets); "Σp" = summed per-transmission rate over the category's autosomal genes (the same genes k is counted on, over exactly the classes k admits); "λ = 2·N·Σp" = the chance expectation; "P(X≥k)" is a LIVE Excel formula  =1−POISSON(k−1, λ, TRUE)  that reproduces the "${headTier.label} p/q" value. p/q for every tier are in their own columns.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner(`Observed: ${meta.nUsed} curation-pass de novo variants (${meta.byClass.nonSplice} nonsense+splice${meta.countFrameshift ? `, ${meta.byClass.frameshift} frameshift` : ''}, ${meta.byClass.mis} missense, ${meta.byClass.syn} synonymous) across ${meta.nDistinctProbands} probands${meta.consequenceColPresent === false ? `. CLASSIFIED BY IMPACT SEVERITY — this data has NO VEP Consequence column, so the class of every variant is inferred from HIGH/MODERATE/LOW. That is an APPROXIMATION and the weakest link on this tab: VEP LOW is NOT synonymous (measured on a real cohort, 34% of LOW rows were splice-region or intronic), and the synonymous class is the model-fit diagnostic below. It ALSO costs the frameshift class entirely — IMPACT lumps frameshift in with nonsense under HIGH and no severity label separates them, so the LoF tier here is SNV-only on BOTH sides (count AND target), which is correct but ~46% less powerful. Add a Consequence column to remove this` : `. Classified by VEP molecular consequence${meta.unmodelledTerms && meta.unmodelledTerms['(blank Consequence cell)'] ? `; ${meta.unmodelledTerms['(blank Consequence cell)']} row${meta.unmodelledTerms['(blank Consequence cell)'] === 1 ? '' : 's'} had a BLANK Consequence cell and were excluded rather than guessed at from IMPACT severity` : ''}`}. Excluded from Test B (still analysed by Test A): ${meta.exclIndel} indels with no rate term, ${meta.exclXY} chrX/Y, ${meta.exclNonCoding} with no modelled consequence, ${meta.exclNoMu} genes with no rate (or non-autosomal), ${meta.exclNoClassMu} with no rate for the variant's own class. ${meta.countFrameshift ? 'FRAMESHIFT IS INCLUDED: it is the one indel class the rate model gives a term (p_lof − p_nonsense+splice), so frameshift de novo indels are counted AND targeted. Other indels (inframe insertion/deletion, or a nonsense/missense call on an indel) have no term and are excluded' : 'Indels are excluded entirely here'}. Autosomal-only is REQUIRED: 2·N counts two parental transmissions, which assumes two copies.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    // The excluded consequences, named. This is not decoration: it is how a reader sees
    // WHAT the model declined to score — e.g. that splice_region/polypyrimidine calls are
    // not synonymous, which is exactly the contamination that would corrupt the model-fit
    // diagnostic if these were classified by IMPACT severity instead.
    const unmodelled = Object.entries(meta.unmodelledTerms || {}).sort((a, b) => b[1] - a[1])
    if (unmodelled.length) {
        banner(`Consequences seen but NOT modelled (no SNV rate term, so they enter neither k nor λ): ${unmodelled.slice(0, 12).map(([t, n]) => `${t} ×${n}`).join(', ')}${unmodelled.length > 12 ? `, … (+${unmodelled.length - 12} more terms)` : ''}. Note what is in this list: every splice_* term other than donor/acceptor (region, polypyrimidine tract, 5th base) is an INTRONIC modifier, not an essential-splice SNV, and none of them are synonymous — which is why classes are taken from the molecular consequence rather than from VEP's IMPACT severity.`,
            {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    }
    const cal = meta.calibration || {}
    banner(`MODEL FIT — the QC readout, and a REAL check (not a tautology). Observed vs expected under λ = 2·N·Σp, exome-wide, per class: synonymous ${cal.syn ? cal.syn.obs : 0} vs ${cal.syn && cal.syn.exp != null ? cal.syn.exp.toFixed(1) : '—'} = ${cal.syn ? fmtR(cal.syn.ratio) : '—'}${cal.synRelSe != null ? ` (±${(100 * cal.synRelSe).toFixed(0)}%)` : ''}  ·  missense ${cal.mis ? cal.mis.obs : 0} vs ${cal.mis && cal.mis.exp != null ? cal.mis.exp.toFixed(1) : '—'} = ${cal.mis ? fmtR(cal.mis.ratio) : '—'}  ·  nonsense+splice ${cal.nonSplice ? cal.nonSplice.obs : 0} vs ${cal.nonSplice && cal.nonSplice.exp != null ? cal.nonSplice.exp.toFixed(1) : '—'} = ${cal.nonSplice ? fmtR(cal.nonSplice.ratio) : '—'}${cal.frameshift ? `  ·  frameshift ${cal.frameshift.obs} vs ${cal.frameshift.exp != null ? cal.frameshift.exp.toFixed(1) : '—'} = ${fmtR(cal.frameshift.ratio)} (the INDEL class — expect it BELOW the synonymous ratio, since de novo indel calling is less sensitive than SNV calling; that gap is exactly what it measures)` : ''}. READ THE SYNONYMOUS ONE FIRST: it is ~selection-neutral, so it should sit near 1.0 and it measures how many de novo variants this cohort actually detects and curates. ≈1 ⇒ the rate model fits and the tests below have their full power. Well under 1 ⇒ you are seeing only that fraction of de novo variants, so every test below is CONSERVATIVE and correspondingly under-powered — not wrong, just quiet. Far ABOVE 1 ⇒ the rate model does not fit this data and nothing below should be trusted (this is the check that caught a 4.5× error in an earlier rate source).`,
        {bold: true, italic: true, size: 10, color: {argb: 'FF1F618D'}})
    // The rate source is the question a reader is most entitled to be sceptical about ("is this
    // model from 2014?"). Answer it with a number they can check, not a citation.
    if (meta.altTable && meta.altTable.agreement) {
        const ag = meta.altTable.agreement
        const pct = (r) => r == null ? '—' : `${((r - 1) * 100).toFixed(1)}%`
        banner(`RATE-SOURCE CROSS-CHECK — the λ above does not depend on which rate table produced it, and you can check that here rather than take it on trust. λ is computed from "${meta.rateTable ? meta.rateTable.label : 'the primary table'}" (${meta.rateGenes.toLocaleString()} modelable autosomal genes) and INDEPENDENTLY from "${meta.altTable.label}" (${(meta.altTable.rateGenes || 0).toLocaleString()} genes); the "λ (cross-check)" column prints the second one per row. Exome-wide the two targets differ by: synonymous ${pct(ag.syn)}  ·  missense ${pct(ag.mis)}  ·  nonsense+splice ${pct(ag.nonSplice)}  ·  LoF ${pct(ag.lof)}. They agree because they are the SAME published mutation model (Samocha 2014) built independently on DIFFERENT transcript sets — one from the DeNovoWEST release, one recomputed with denovonear over MANE Select v1.5/GRCh38 — so a per-row ratio near 1 means the rate source is NOT what is carrying that row. A ratio far from 1 means the two transcript sets disagree about that gene's size, which is a fact about annotation, not about your cohort. There is no second p-value and no second FDR family: a second p would only invite reading whichever is smaller.`,
            {italic: true, size: 10, color: {argb: 'FF117864'}})
    }
    banner(`NO SCALE IS FITTED to this cohort, deliberately. An empirical calibration (ê = observed_syn ÷ expected_syn, applied as λ = 2·N·Σp·ê) was built and REMOVED: measured, it made the test 1.4–3.0× too permissive on exactly the categories read first (its noise enters λ un-propagated, worse the larger the category), and it imported curation bias, since a reviewer who passes damaging variants more readily than synonymous ones shrinks every λ. Un-calibrated, λ is a fixed target: MISSING de novo variants (detection f ≤ 1, so E[k] = λ·f) can only make the POISSON too quiet, never too loud — its λ never touches the observed synonymous count, so no curation habit can shrink it. The price is power when the synonymous ratio is well below 1, and that ratio above is exactly what tells you. TWO HONEST LIMITS ON THAT, because "conservative" is not unconditional. (1) It assumes the cohort only MISSES de novo variants. A variant miscalled de novo — an inherited allele or an artefact passing the trio filter — inflates k against a fixed λ and pushes the Poisson the other way; the curation gate, not this model, is what stands between you and that. (2) It applies to the POISSON ONLY. The "p/q (scale-free)" test conditions on each row\'s own synonymous count, so a reviewer who passes damaging variants more readily than synonymous ones moves θ itself and that test CAN over-reject — where the Poisson merely loses power. The "p/q (share)" test is immune to a uniform cohort-wide shift but not to a CLASS-skewed one, for the same reason. Curation that treats the classes alike costs power and nothing else; curation that favours damage is the one regime the two conditional tests cannot absorb. Refs: Samocha 2014 Nat Genet 46:944 (model); Kaplanis & Samocha 2020 Nature 586:757 + DeNovoWEST, MIT (rates); Benjamini-Hochberg 1995; Benjamini-Yekutieli 2001 (FDR under the nested tiers' positive dependence).`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner(`CURATION — the assumption behind every count here, stated plainly. Every variant counted above is a CURATION-PASS de novo. The tests ask whether damaging de novo exceed the mutation rate; they cannot know WHY a variant was passed. The assumption is that review is CLASS-BLIND — that synonymous de novo are examined as readily as damaging ones. Nothing in this tool filters review by impact, so that holds by default; it can be broken only by a reviewing habit, and the model-fit ratios above are how you would see it. Read them together: if synonymous were reviewed less than damaging, the synonymous ratio would sit BELOW the damaging ratios, and the gap between the class ratios is the measure of it. Note this cannot make the Poisson over-reject — λ never uses the synonymous count — it would only mean the synonymous ratio understates true detection, i.e. the tests are even more conservative than it suggests.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})

    banner(`CONVERGENCE vs RECURRENCE — read the "# genes" column before you read the ✓. A category is CONVERGENCE only if SEVERAL DIFFERENT genes in it carry de novo variants. One recurrent gene belongs to many categories at once and lights up every one: measured on these very libraries, a single gene with 3 nonsense de novo produces 22 category rows and 11 ✓ marks, each reading "# genes = 1". Those are not 11 findings — they are ONE gene seen 11 times, and its honest home is the "DNM Rate (per-gene)" tab. Category names are bolded only when ≥2 distinct genes carry them, for exactly this reason: a ✓ on a 1-gene row is the per-gene result restated, not a gene set converging.`,
        {bold: true, italic: true, size: 10, color: {argb: 'FFB9770E'}})
    if (!reliable) banner('⚠ PROVISIONAL N: no Sample-QC trio file, so N counts only probands carrying a variant and is a LOWER BOUND → λ is too small → the Poisson p/q are anti-conservative. They are printed but are NOT the basis of any ✓ here. NO ✓ IS AWARDED ON THIS TAB AT ALL while N is provisional — the ✓ is gated on the Poisson, and the Poisson is the test N breaks. Read the "p/q (scale-free)" columns instead: that test conditions on each row\'s own total, so N cancels out of it identically and it stays valid — it simply is not decorated. Load a --sample-qc file to get a defensible N and the rate-based test back.',
        {bold: true, italic: true, size: 10, color: {argb: 'FFB03A2E'}})
    r++; ws.addRow([])

    const headers = ['Category', ...tiers.map(t => t.label), '# genes', '# probands',
        ...tiers.map(t => `${t.label} p/q`),
        ...tiers.map(t => `${t.label} p/q (scale-free)`),
        ...tiers.map(t => `${t.label} p/q (share)`),
        `k (${headTier.label})`, 'k syn', 'Σp', 'Σp syn', 'θ', 'λ = 2·N·Σp', 'P(X≥k)',
        'K (cohort)', 'π = Σp/Σp(exome)', 'exp share = K·π', 'P(X≥k | K)',
        ...(meta.altTable ? ['λ (cross-check)', 'λ ratio'] : []), 'Genes']
    r++
    const hdr = ws.addRow(headers)
    hdr.eachCell(c => { c.fill = headerFill; c.font = headerFont; c.border = borderThin; c.alignment = {vertical: 'middle', horizontal: 'center', wrapText: true} })
    hdr.height = 26
    const headerRowIdx = r
    ws.getColumn(1).width = 34
    for (let i = 0; i < nT; i++) ws.getColumn(T0 + i).width = 13
    ws.getColumn(CG).width = 8; ws.getColumn(CP).width = 10
    for (let i = 0; i < nT; i++) ws.getColumn(PQ0 + i).width = 14
    for (let i = 0; i < nT; i++) ws.getColumn(CQ0 + i).width = 16
    ws.getColumn(DK).width = 8; ws.getColumn(DKS).width = 8; ws.getColumn(DMU).width = 11
    ws.getColumn(DMUS).width = 11; ws.getColumn(DTH).width = 8
    ws.getColumn(DLAM).width = 11; ws.getColumn(DP).width = 11
    ws.getColumn(GENES).width = 48

    let any = false
    for (const sec of sections) {
        if (!sec.groups.length) continue
        any = true
        r++
        const hidden = Math.max(0, sec.groups.length - MAX_GROUPS_PER_DIM)
        const shown = sec.groups.slice(0, MAX_GROUPS_PER_DIM)
        const note = sec.muSource ? '' : '  ·  no de novo rate for this dimension\'s genes'
        // BH family m — every (category × tier) cell with a λ, including the no-hit cells
        // and the categories the minCount rule hides. q is family-wide; print m so it can
        // be audited from a single row.
        // m counts the A-PRIORI grid (every library category with a modelable λ × every tier),
        // while nCategories counts only the categories a de novo actually landed in. Calling
        // the latter "categories tested" contradicted the former: the un-hit categories ARE
        // tested (k=0 ⇒ exact p=1) and are exactly why m is larger. Name each for what it is.
        const mNote = sec.m != null ? `  ·  BH family m=${sec.m} (every category × tier cell with a λ, including the un-hit ones: k=0 gives the exact p=1, so they cannot be rejected but must still count${sec.nCategories != null ? `; ${sec.nCategories} categor${sec.nCategories === 1 ? 'y' : 'ies'} here carried ≥1 de novo` : ''})` : ''
        const secRow = ws.addRow([`${sec.label}${hidden ? `   (top ${shown.length} of ${sec.groups.length})` : ''}${note}${mNote}`])
        mergeAcross(r)
        secRow.getCell(1).font = {bold: true, color: {argb: 'FF2C3E50'}}
        for (let c = 1; c <= nCols; c++) secRow.getCell(c).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFEBDEF0'}}

        shown.forEach((g, idx) => {
            const rowNum = r + 1
            const hc = g.cells[headTier.key]
            const genesStr = g.genes.length > 16 ? g.genes.slice(0, 16).join(', ') + ` +${g.genes.length - 16}` : g.genes.join(', ')
            const vals = [g.term]
            for (const t of tiers) vals.push(kStr(g.cells[t.key]))
            vals.push(g.genes.length, g.probands)
            for (const t of tiers) vals.push(pqStr(g.cells[t.key]))
            for (const t of tiers) vals.push(condStr(g.cells[t.key]))
            for (const t of tiers) vals.push(shareStr(g.cells[t.key]))
            // derivation (headTier), with live Excel formulas
            const kA = colLetter(DK) + rowNum, muA = colLetter(DMU) + rowNum, lamA = colLetter(DLAM) + rowNum
            const muSA = colLetter(DMUS) + rowNum
            vals.push(hc.k, hc.kSyn, hc.catMu, hc.catMuSyn)
            // θ = Σp / (Σp + Σp_syn) — live, so a reader can see that 2·N is simply not in
            // it. That absence IS the scale-free property, not a claim about it.
            vals.push(hc.theta != null ? {formula: `${muA}/(${muA}+${muSA})`, result: hc.theta} : '—')
            // λ = 2·N·Σp exactly — no fitted scale, so the formula IS the model.
            vals.push(hc.lambda != null ? {formula: `2*${N}*${muA}`, result: hc.lambda} : '—')
            vals.push((hc.k > 0 && hc.lambda != null)
                ? {formula: `1-POISSON(${kA}-1,${lamA},TRUE)`, result: hc.p}
                : '—')
            // The cohort-conditioned derivation, live: π and the expected share are formulas so a
            // reader can SEE that neither N nor the absolute scale appears anywhere in them.
            vals.push(hc.kCohort != null ? hc.kCohort : '—')
            vals.push(hc.pi != null ? hc.pi : '—')
            const kcA = colLetter(SK) + rowNum, piA = colLetter(SPI) + rowNum
            vals.push(hc.expShare != null ? {formula: `${kcA}*${piA}`, result: hc.expShare} : '—')
            vals.push(hc.pShare != null ? {formula: `1-BINOMDIST(${kA}-1,${kcA},${piA},TRUE)`, result: hc.pShare} : '—')
            // The cross-check λ for the same k under the OTHER rate table, and the ratio. Near 1
            // ⇒ the rate source is not carrying this row. No p — see the cross-check banner.
            if (meta.altTable) {
                vals.push(hc.lambdaAlt == null ? '—' : hc.lambdaAlt)
                vals.push(hc.lambdaRatio == null ? '—' : hc.lambdaRatio)
            }
            vals.push(genesStr)
            r++
            const row = ws.addRow(vals)
            row.eachCell(c => { c.border = borderThin; if (idx % 2 === 1) c.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}} })
            for (let i = 0; i < nT; i++) row.getCell(T0 + i).alignment = {horizontal: 'center'}
            for (const c of [CG, CP, DK, DKS, DMU, DMUS, DTH, DLAM, DP]) row.getCell(c).alignment = {horizontal: 'center'}
            if (nAlt) {
                for (const c of [DLAMALT, DRATIO]) row.getCell(c).alignment = {horizontal: 'center'}
                if (typeof hc.lambdaAlt === 'number') row.getCell(DLAMALT).numFmt = FMT_LAM
                if (typeof hc.lambdaRatio === 'number') row.getCell(DRATIO).numFmt = '0.000'
            }
            for (let i = 0; i < nT; i++) { row.getCell(PQ0 + i).alignment = {horizontal: 'center'}; row.getCell(CQ0 + i).alignment = {horizontal: 'center'} }
            row.getCell(DMU).numFmt = FMT_MU; row.getCell(DMUS).numFmt = FMT_MU
            row.getCell(DTH).numFmt = '0.0000'
            row.getCell(DLAM).numFmt = FMT_LAM; row.getCell(DP).numFmt = FMT_PVAL
            tiers.forEach((t, i) => { if (isSig(g.cells[t.key])) { row.getCell(T0 + i).font = {bold: true, color: {argb: 'FF6C3483'}}; row.getCell(PQ0 + i).font = {bold: true, color: {argb: 'FF6C3483'}} } })
            // Bold the category ONLY when >=2 DISTINCT GENES carry it. That is the whole
            // difference between convergence and recurrence: a category lit up by a single
            // recurrent gene is the per-gene finding restated, not a gene set converging.
            // Measured: SCN1A with 3 nonsense de novo lights 22 category rows across the
            // dimensions, 11 of them q<0.05 — every one reading "# genes = 1". Bolding on k
            // alone would have put 11 emphatic marks on ONE finding.
            if (hc.k >= 2 && g.genes.length >= 2) row.getCell(1).font = {bold: true}
        })
        if (hidden) { r++; const nr = ws.addRow([`… ${hidden} more categor${hidden === 1 ? 'y' : 'ies'} not shown (ranked below the top ${MAX_GROUPS_PER_DIM} by p-value).`]); mergeAcross(r); nr.getCell(1).font = {italic: true, size: 9, color: {argb: 'FF6B7D8D'}} }
    }
    if (!any) { r++; ws.addRow([`No category has an observed de novo variant in a gene with a bundled de novo mutation rate (Samocha 2014, ${meta.rateTable ? meta.rateTable.label : 'the bundled table'}) in the current export.`]); mergeAcross(r) }
    ws.views = [{state: 'frozen', ySplit: headerRowIdx}]
}

/**
 * "DNM Rate (per-gene)" tab — the de novo mutation-rate enrichment at GENE level.
 * One row per (gene, track) with an observed de novo variant: k vs Poisson λ = 2·N·p,
 * live =1-POISSON(k-1, λ, TRUE). LoF / missense / protein-altering are separate BH
 * discovery families; synonymous is the calibration control (no discovery q). `dnm` =
 * computeModelEnrichment() output (needs dnm.perGene). Wrapped by the caller in try/catch.
 */
function buildDnmRatePerGeneTab(workbook, dnm, styles) {
    const {headerFill, headerFont, borderThin} = styles
    const ws = workbook.addWorksheet('DNM Rate (per-gene)')
    const meta = dnm.meta, pg = dnm.perGene, N = meta.N || 0, reliable = !!meta.nReliable
    const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }
    const FMT_PVAL = '[<0.001]0.0E+00;0.000', FMT_MU = '0.00E+00', FMT_LAM = '[<0.05]0.0E+00;0.000'
    const isSig = (row) => reliable && row.discovery && row.q != null && row.q < 0.05   // ✓ withheld when provisional
    const MAX_PER_TRACK = 100

    // nAlt is 0 or 2: the cross-check λ columns are INSERTED after q, so every constant after
    // them is derived rather than hardcoded — otherwise LOEUF would silently be written into
    // the λ-ratio column when the second rate table is present.
    const nAlt = (dnm.meta && dnm.meta.altTable) ? 2 : 0
    const G = 1, K = 2, MU = 3, LAM = 4, P = 5, Q = 6
    const SK = 7, SPI = 8, SP = 9, SQ = 10                 // cohort-conditioned share test
    const LAMALT = nAlt ? 11 : null, RATIO = nAlt ? 12 : null
    const LOEUF = 11 + nAlt, PLI = 12 + nAlt, CONS = 13 + nAlt, nCols = 13 + nAlt
    const mergeAcross = (rr) => ws.mergeCells(rr, 1, rr, nCols)
    let r = 0
    const banner = (text, font) => { r++; const row = ws.addRow([text]); mergeAcross(r); row.getCell(1).font = font; row.getCell(1).alignment = {wrapText: true, vertical: 'top'}; return row }

    banner('Gene Analysis — DE NOVO MUTATION-RATE enrichment, PER GENE (Test B)', {bold: true, size: 14, color: {argb: 'FF2C3E50'}})
    banner(`Per-gene view of the same test as "DNM Rate (gene-set)". One row per (gene, track) with an observed curation-pass de novo variant: k ~ Poisson(λ = 2·N·p), N = ${N} trios${reliable ? '' : ' (PROVISIONAL — no Sample-QC file)'}, p = the gene's per-transmission de novo rate for that track's classes (Samocha 2014 model, from ${meta.rateTable ? meta.rateTable.label : 'the bundled rate table'}). No scale is fitted. The LOEUF / pLI columns are the SECOND axis: λ says how SURPRISING the count is (a big, mutable gene expects more by chance), constraint says whether a real variant there would MATTER. They answer different questions and are deliberately not merged — read them together. "P(X≥k)" is a LIVE Excel formula reproducing the q's p-value.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner(`Per-gene λ is tiny, so a single de novo hit rarely survives FDR — power comes from RECURRENCE (≥2 de novos in one gene). The scan is EXOME-WIDE, so each discovery family m counts EVERY autosomal gene with a modelable μ for that track — not just the genes that happened to carry a de novo. A gene with no de novo has the exact p = P(X≥0) = 1 and can never be rejected, but it is still one of the hypotheses the scan asked; correcting only across observed genes would let the data pick the family and put the true FDR far above the nominal 5%. Only genes with k≥1 are listed below (the rest are all p=1). Discovery family m (autosomal genes scanned) — LoF ${pg.familySizes.lof || 0}, missense ${pg.familySizes.mis || 0}, protein-altering ${pg.familySizes.protein_altering || 0}; rows shown with an observed de novo — ${(pg.observedRows && pg.observedRows.lof) || 0} / ${(pg.observedRows && pg.observedRows.mis) || 0} / ${(pg.observedRows && pg.observedRows.protein_altering) || 0}.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    // TWO scale-free tests exist; only ONE works at gene level, and the distinction is the
    // whole reason this tab looks different from the gene-set one.
    //   - synonymous-conditioned (the gene-set tab's "p/q (scale-free)"): NOT offered here, and
    //     that is a measured decision, not laziness. A gene expects ~0.004 synonymous de novo at
    //     N=220, so T = k + k_syn collapses to k and the test degenerates to p = θ^k — a number
    //     that uses nothing about the gene's target size.
    //   - cohort-conditioned (the "P(X≥k | K)" columns below): IS offered, and works, because it
    //     conditions on the cohort's total instead of a gene's synonymous handful, which puts
    //     gene size back in through π. Do not "tidy" these columns away on the strength of the
    //     paragraph above — they are a different test.
    // This comment previously said the scale-free test was not offered here, full stop, while the
    // columns were shipping ten lines below it.
    // WHY ISN'T MY GENE HERE. This tab is where a reader goes looking for one specific gene, so
    // the exclusions have to be legible HERE and not only on the gene-set tab. A HIGH-impact
    // variant silently absent is the single most alarming thing this tab can do.
    const pgUnmodelled = Object.entries(meta.unmodelledTerms || {}).sort((a, b) => b[1] - a[1])
    banner(`WHY A GENE YOU EXPECTED MAY BE ABSENT — this tab lists only (gene, track) pairs with an observed de novo variant that the RATE MODEL can score, which is narrower than "HIGH impact". A gene is absent if it has no curation-PASS variant, if the variant is not \`de_novo\`, if it is on chrX/Y (2·N assumes two autosomal copies), if the gene has no bundled rate, or — the one that surprises people — if the variant's molecular CONSEQUENCE has no term in the Samocha 2014 model. IMPACT severity is NOT the gate: VEP calls start_lost, stop_lost and stop_retained HIGH, but the model has no rate for any of them, so they enter neither k nor λ. Counting them against the nonsense+splice rate would inflate k with no matching λ and manufacture significance. ${pgUnmodelled.length ? `In THIS export the unmodelled consequences were: ${pgUnmodelled.slice(0, 12).map(([t, n]) => `${t} ×${n}`).join(', ')}${pgUnmodelled.length > 12 ? `, +${pgUnmodelled.length - 12} more` : ''}.` : 'In this export every observed consequence was modelled.'} Excluded counts for this export: ${meta.exclNonCoding} unmodelled consequence, ${meta.exclIndel} indel with no rate term, ${meta.exclXY} chrX/Y, ${meta.exclNoMu} no gene rate, ${meta.exclNoClassMu} no rate for the variant's own class. EVERY one of them is still counted by Test A on the Gene Analysis tabs, which is origin-agnostic and models no rates — nothing vanishes from the workbook, it just leaves THIS test.`,
        {italic: true, size: 10, color: {argb: 'FFB9770E'}})

    banner(`THE "P(X≥k | K)" COLUMN — the scale-free test that DOES work at gene level, and why it is a different one from the gene-set tab's. That tab conditions a category on its OWN synonymous count; a GENE has none to speak of. At N=${N} the average gene expects ${meta.rateGenes > 0 ? (2 * N * meta.totalP.syn / meta.rateGenes).toFixed(4) : "≈0.004"} synonymous de novo (2·N·Σp_syn ÷ ${meta.rateGenes ? meta.rateGenes.toLocaleString() : "~18.5k"} genes) — well under a 1% chance of even one — so T would equal k and that test would collapse to p = θ^k, which uses NOTHING about the gene's target size: a huge gene and a tiny one, each with 2 nonsense de novo, would get an IDENTICAL p. Gene size is precisely the information a per-gene rate test exists to use. So this column conditions on the COHORT's total instead: k | K ~ Binomial(K, π) with π = p(gene) ÷ Σp(exome) and K = ${meta.byClass ? "the cohort's own de novo count for that track" : "the cohort total"}. K is a real number, so gene size re-enters through π and the test has power. Measured on this design: TTN (largest target) and MTRNR2L5 (smallest), both with k=2, give P = 6.7e-3 vs 1.3e-9 — size is doing the work. It needs NO trio count and NO absolute rate scale, so it stays valid when N is provisional, exactly when the Poisson beside it is least trustworthy. READ IT AS A COMPANION, NOT A TIEBREAK: the two answer different questions and have SEPARATE FDR families. The Poisson asks "more than the germline rate predicts?" — it can see an ABSOLUTE excess but its obs/exp is corrupted in exact proportion by any cohort-wide artefact (measured: a uniform 3× inflation from lenient curation or a hypermutator moves it 867→2600, a fabricated effect). This one asks "over-represented among the de novo we ACTUALLY SAW?" — its obs/exp = k/(K·π) is INVARIANT under that same 3× inflation (465.0 either way), because the multiplier lands in k and K alike and divides out. The price is the mirror image: a GENUINE exome-wide excess divides out too, so it can only ever report a RELATIVE excess. Note both p-values still shrink as the cohort grows — that is more data measuring the same share, not the artefact being handled. Read the obs/exp, not the p, when you want the artefact-proof number. Method: Kobren, Moldovan et al., Nat Commun 2025 (RaMeDiES); implemented from the published description.`,

        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    if (!reliable) banner('⚠ PROVISIONAL N: no Sample-QC trio file → N is a lower bound → λ too small → anti-conservative p; ✓ withheld. N-FREE FALLBACK: read the "P(X≥k | K)" / "q (share)" columns instead. That test conditions on K — the cohort\'s own de novo count for THAT TRACK\'S classes — so neither the trio count nor the absolute rate scale enters it, and it stays valid here. It is simply not decorated with a ✓, because the ✓ is gated on the Poisson.)', {bold: true, italic: true, size: 10, color: {argb: 'FFB03A2E'}})
    r++; ws.addRow([])

    const altT = meta.altTable || null
    // The cross-check λ rides beside the primary one. A ratio near 1 says the rate source is not
    // carrying the row; '—' says the OTHER table has no rate for this gene (e.g. MYC, which
    // DeNovoWEST leaves rate-less at p_all=NA) — which is 'unknown', never 'zero target'.
    const headers = ['Gene', 'k (de novo variants)', 'p (rate)', 'λ = 2·N·p', 'P(X≥k)', 'q',
        'K (cohort)', 'π = p/Σp(exome)', 'P(X≥k | K)', 'q (share)',
        ...(altT ? ['λ (cross-check)', 'λ ratio'] : []), 'LOEUF', 'pLI', 'Constrained?']
    r++
    const hdr = ws.addRow(headers)
    hdr.eachCell(c => { c.fill = headerFill; c.font = headerFont; c.border = borderThin; c.alignment = {vertical: 'middle', horizontal: 'center', wrapText: true} })
    hdr.height = 26
    const headerRowIdx = r
    ws.getColumn(G).width = 20; ws.getColumn(K).width = 15; ws.getColumn(MU).width = 12
    ws.getColumn(LAM).width = 12; ws.getColumn(P).width = 12; ws.getColumn(Q).width = 12

    let any = false
    for (const tr of pg.tracks) {
        const rows = pg.rows.filter(x => x.track === tr.key)
        if (!rows.length) continue
        any = true
        r++
        const shown = rows.slice(0, MAX_PER_TRACK)
        // m is the EXOME-WIDE family actually corrected for (every autosomal gene with a
        // μ for this track) — not rows.length, which is only the genes with an observed
        // de novo. Printing rows.length here would contradict the q's in the sheet.
        const mFam = (pg.familySizes && pg.familySizes[tr.key]) || rows.length
        const note = tr.discovery
            ? `discovery family — Benjamini-Hochberg over ${mFam.toLocaleString()} autosomal gene${mFam === 1 ? '' : 's'} scanned (${rows.length} with an observed de novo; the rest are p=1)`
            : 'CALIBRATION control — no discovery q'
        const secRow = ws.addRow([`${tr.label}   ·   ${note}${rows.length > MAX_PER_TRACK ? `   (top ${MAX_PER_TRACK} of ${rows.length})` : ''}`])
        mergeAcross(r)
        secRow.getCell(1).font = {bold: true, color: {argb: 'FF2C3E50'}}
        for (let c = 1; c <= nCols; c++) secRow.getCell(c).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFEBDEF0'}}

        shown.forEach((row, idx) => {
            const rowNum = r + 1
            const muA = colLetter(MU) + rowNum, kA = colLetter(K) + rowNum, lamA = colLetter(LAM) + rowNum
            // The SECOND axis, beside the rate. Surprise (λ, p) says a de novo here is
            // unexpected; constraint says a real one would MATTER. They are independent
            // questions and are deliberately NOT merged into one score — merging them
            // would hide which of the two is carrying a row.
            const con = row.constraint || {}
            const vals = [isSig(row) ? `${row.gene} ✓` : row.gene, row.k, row.mu,
                {formula: `2*${N}*${muA}`, result: row.lambda},
                (row.k > 0 && row.lambda != null) ? {formula: `1-POISSON(${kA}-1,${lamA},TRUE)`, result: row.p} : '—',
                tr.discovery ? (row.q == null ? '—' : row.q) : 'cal',
                // The cohort-conditioned test — the ONLY scale-free one that works at gene
                // level (see the banner). Live formula: no N, no absolute scale in it.
                row.kCohort == null ? '—' : row.kCohort,
                row.pi == null ? '—' : row.pi,
                row.pShare == null ? '—'
                    : {formula: `1-BINOMDIST(${kA}-1,${colLetter(SK)}${rowNum},${colLetter(SPI)}${rowNum},TRUE)`, result: row.pShare},
                tr.discovery ? (row.qShare == null ? '—' : row.qShare) : 'cal',
                ...(altT ? [row.lambdaAlt == null ? '—' : row.lambdaAlt,
                    row.lambdaRatio == null ? '—' : row.lambdaRatio] : []),
                con.loeuf != null ? con.loeuf : '—',
                con.pli != null ? con.pli : '—',
                // Use the provider's isConstrained — it declares itself the SINGLE SOURCE OF
                // TRUTH for this flag, and re-implementing the rule here is precisely the drift
                // that lets one tab call a gene constrained while another does not.
                con.loeuf == null && con.pli == null ? '—'
                    : (gnomadProvider.isConstrained(con) ? 'Yes' : 'No')]
            r++
            const xr = ws.addRow(vals)
            xr.eachCell(c => { c.border = borderThin; if (idx % 2 === 1) c.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}} })
            for (const c of [K, MU, LAM, P, Q, LOEUF, PLI, CONS]) xr.getCell(c).alignment = {horizontal: 'center'}
            if (typeof vals[SPI - 1] === 'number') xr.getCell(SPI).numFmt = FMT_MU
            if (tr.discovery && typeof vals[SQ - 1] === 'number') xr.getCell(SQ).numFmt = FMT_PVAL
            xr.getCell(SP).numFmt = FMT_PVAL
            if (nAlt) {
                if (typeof vals[LAMALT - 1] === 'number') xr.getCell(LAMALT).numFmt = FMT_LAM
                if (typeof vals[RATIO - 1] === 'number') xr.getCell(RATIO).numFmt = '0.000'
            }
            if (typeof vals[LOEUF - 1] === 'number') xr.getCell(LOEUF).numFmt = '0.00'
            if (typeof vals[PLI - 1] === 'number') xr.getCell(PLI).numFmt = '0.00'
            xr.getCell(MU).numFmt = FMT_MU; xr.getCell(LAM).numFmt = FMT_LAM; xr.getCell(P).numFmt = FMT_PVAL
            if (tr.discovery && typeof vals[Q - 1] === 'number') xr.getCell(Q).numFmt = FMT_PVAL
            if (isSig(row)) { xr.getCell(G).font = {bold: true, color: {argb: 'FF6C3483'}}; xr.getCell(Q).font = {bold: true, color: {argb: 'FF6C3483'}} }
        })
    }
    if (!any) { r++; ws.addRow(['No gene has an observed de novo variant in a gene with a bundled per-gene de novo rate in the current export.']); mergeAcross(r) }
    ws.views = [{state: 'frozen', ySplit: headerRowIdx}]
}

module.exports = {
    buildReadmeSheet, buildGaDerivationSheet, buildGeneAnalysisTab,
    buildDnmRateCategoryTab, buildDnmRatePerGeneTab,
    GA_SAMPLE_TRACK, GA_DNM_TRACK, colLetterOf
}
