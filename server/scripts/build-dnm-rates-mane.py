#!/usr/bin/env python3
"""Build data/annotations/dnm_rates.mane.json.gz — the MANE Select v1.5 / GRCh38 rebuild of
the same Samocha 2014 trinucleotide de novo rate model that ships in dnm_rates.json.gz.

WHY A SECOND TABLE. Not because the first is wrong — the two agree to 0.6% per gene (median
ratio 1.002, p10 0.994, p90 1.006), because they are the SAME 2014 rate model. They differ in
TRANSCRIPTS. The bundled DeNovoWEST table is on 2014-era transcripts, so joining it to current
gene symbols needs HGNC prev/alias resolution (868 symbols rescued, 25 rejected by a chromosome
guard, 98.55% join). This table is built on MANE Select v1.5 with current symbols, so the join
is direct. Shipping both lets the workbook PRINT the agreement rather than assert it: if a
category's lambda is the same under two independently-built tables, the rate source is not what
is carrying the finding. Two independent implementations agreeing is the supplement's evidence.

FIELD PARITY IS DELIBERATE. This emits exactly the fields dnm_rates.json.gz emits —
{pSyn, pMis, pNonSplice, pLof, chr} — so dnm-enrichment.js consumes either table with NO code
change, and rateFor(rec,'frameshift') = pLof - pNonSplice works identically on both.

  pSyn       = synonymous_rate
  pMis       = missense_rate
  pNonSplice = nonsense_rate + splice_lof_rate   (SNV-only LoF, matching the other table's
               p_all - p_syn - p_mis residual)
  pLof       = pNonSplice + frameshift_rate      (matching the other table's published p_lof)

denovonear emits frameshift_rate DIRECTLY, so pLof is composed here rather than subtracted.
Both routes recover the same quantity: frameshift/(non+splice) reads 0.854 here, 0.851 in the
DeNovoWEST table, 0.855 in denovolyzeR.

WHAT THE FRAMESHIFT RATE ACTUALLY IS — measured, and a limitation to disclose, not hide.
It is a FLAT PER-BP CONSTANT times CDS length: frameshift_rate/length takes exactly ONE value
across all 19,228 genes (6.8043e-10), calibrated so the exome total = 1.25x total nonsense
(Samocha 2014's stated assumption). The DeNovoWEST table's frameshift is the same construction
with the same constant (6.8108e-10). For contrast, the context-aware nonsense+splice rate per bp
takes 19,342 distinct values spanning 54x. So the frameshift half of the LoF target carries NO
sequence context — homopolymers and short tandem repeats, the real indel hotspots, get no credit.
That is the model's simplification, shared by every implementation of it.

TWO SILENT-CORRUPTION HAZARDS, handled explicitly:
  1. "NA" in a rate column means log10(0), i.e. a TRUE rate of exactly 0.0 — never "missing".
     2,142 single-exon-CDS genes have splice_lof_rate=NA. Dropping them would lose 11% of genes;
     treating NA as missing would silently break pNonSplice.
  2. A genuinely FAILED gene has NA in EVERY rate column, and its `chrom` is ALSO corrupt:
     denovonear's except-handler reuses `tx` from the previous loop iteration, so it reports the
     PREVIOUS gene's chromosome (TMEM247, truly chr2, is emitted as chr9 = TMEM245's). Such rows
     are dropped, never trusted. Exactly 1 gene (TMEM247) hits this.

UPSTREAM — how to regenerate the input (offline; NOT reproducible from `npm`, which is why the
built bundle is committed):
    pip install denovonear==0.13.0                      # MIT, github.com/jeremymcrae/denovonear
    # MANE Select v1.5 GTF (public domain, NCBI/EBI):
    #   https://ftp.ncbi.nlm.nih.gov/refseq/MANE/MANE_human/release_1.5/
    #     MANE.GRCh38.v1.5.select_ensembl_genomic.gtf.gz
    # GRCh38 primary assembly FASTA (public domain)
    denovonear rates --gtf mane.gtf --fasta GRCh38.fa --out rates_all.samocha.txt
Then:
    python3 scripts/build-dnm-rates-mane.py rates_all.samocha.txt

LICENCE: denovonear is MIT (Genome Research Ltd); MANE is public domain (NCBI/EBI); the Samocha
2014 model is published method. All redistributable — this bundle ships in-repo.

CITE: Samocha et al., Nat Genet 2014;46:944 (the model); denovonear (jeremymcrae/denovonear, MIT);
MANE Select v1.5 (Morales et al., Nature 2022;604:310).
"""
import csv, gzip, json, os, sys

RATE_COLS = ['missense_rate', 'nonsense_rate', 'splice_lof_rate',
             'splice_region_rate', 'synonymous_rate']
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', 'data', 'annotations', 'dnm_rates.mane.json.gz')


def val(x):
    """NA == log10(0) == exactly 0.0. Anything else is a log10 rate -> exponentiate."""
    return 0.0 if x == 'NA' else 10 ** float(x)


def main(src):
    genes, dropped, dup = {}, [], 0
    for r in csv.DictReader(open(src), delimiter='\t'):
        # Failure sentinel: every rate NA -> denovonear logged an error for this gene and its
        # `chrom` is inherited from the previous row. Untrustworthy in full; drop.
        if all(r[c] == 'NA' for c in RATE_COLS):
            dropped.append(r['transcript_id'])
            continue
        sym = r['transcript_id'].upper()
        chrom = r['chrom']
        if chrom.lower().startswith('chr'):
            chrom = chrom[3:]
        non, spl = val(r['nonsense_rate']), val(r['splice_lof_rate'])
        fs = val(r.get('frameshift_rate', 'NA'))
        pNonSplice = non + spl
        pLof = pNonSplice + fs
        if sym in genes:
            dup += 1
            continue
        genes[sym] = {
            'pSyn': val(r['synonymous_rate']),
            'pMis': val(r['missense_rate']),
            'pNonSplice': pNonSplice,
            'pLof': pLof,
            'chr': chrom,
        }

    def auto(c):
        return c.isdigit() and 1 <= int(c) <= 22

    sS = sum(g['pSyn'] for g in genes.values() if auto(g['chr']))
    sM = sum(g['pMis'] for g in genes.values() if auto(g['chr']))
    sN = sum(g['pNonSplice'] for g in genes.values() if auto(g['chr']))
    sL = sum(g['pLof'] for g in genes.values() if auto(g['chr']))
    nX = sum(1 for g in genes.values() if g['chr'] == 'X')

    print(f'  {len(genes):,} genes ({len(dropped)} all-NA/failed dropped: {dropped or "none"}; {dup} dup symbols)')
    print(f'  chrX genes: {nX:,}   (kept in the bundle; Test B gates X out by an explicit chr check)')
    print(f'  autosomal Sum p: syn={sS:.6f} mis={sM:.6f} non+splice={sN:.6f} lof={sL:.6f}')
    print(f'  sanity: (non+splice)/syn        = {sN/sS:.4f} (expect ~0.16-0.17)')
    print(f'  sanity: p_lof/syn               = {sL/sS:.4f} (expect ~0.30)')
    print(f'  sanity: frameshift/(non+splice) = {(sL-sN)/sN:.4f} (expect ~0.85)')
    print(f'  sanity: 2*Sum(syn+mis+non+splice) = {2*(sS+sM+sN):.3f} coding de novo SNVs/trio (published ~1.0-1.3)')

    payload = {
        'meta': {
            '_source': 'denovonear 0.13.0 (MIT, Genome Research Ltd) over MANE Select v1.5 / GRCh38',
            '_model': 'Samocha et al. 2014, Nat Genet 46:944 - trinucleotide de novo mutation model '
                      '(denovonear bundled rates.txt). The SAME model as data/annotations/dnm_rates.json.gz; '
                      'this table differs only in TRANSCRIPTS (MANE Select v1.5/GRCh38, current symbols) - '
                      'the two agree to 0.6% per gene.',
            '_citation': 'Samocha et al., Nat Genet 2014;46:944 (model); denovonear - github.com/jeremymcrae/denovonear (MIT); '
                         'MANE Select v1.5 - Morales et al., Nature 2022;604:310',
            '_transcripts': 'MANE Select v1.5 (NCBI/EBI, public domain), primary chromosomes, protein_coding',
            '_license': 'MIT (denovonear) + public domain (MANE). Redistributable.',
            '_fields': {
                'pSyn': 'synonymous_rate - per-transmission synonymous de novo probability',
                'pMis': 'missense_rate - per-transmission missense de novo probability',
                'pNonSplice': 'nonsense_rate + splice_lof_rate - per-transmission nonsense + essential-splice, SNV ONLY',
                'pLof': 'pNonSplice + frameshift_rate - the same PLUS frameshift indels',
                'chr': 'chromosome (bare: 1..22, X, Y)',
            },
            '_note': 'Rates carry NO depth adjustment and NO fitted scale: lambda = 2*N*p, where 2 = the two '
                     'parental transmissions at risk per proband. TWO LoF rates ship because they pair with '
                     'different observed counts - pair pNonSplice with an SNV-only count, pLof with a count '
                     'that admits frameshift de novo indels. Mixing them moves lambda by 1.85x. NB the '
                     'frameshift component is a FLAT per-bp constant (6.8043e-10) x CDS length, calibrated so '
                     'the exome total = 1.25x total nonsense (Samocha 2014s assumption) - it carries NO '
                     'sequence context, unlike every other class here.',
            '_gates': {
                'nonSplice_over_syn': round(sN / sS, 4),
                'pLof_over_syn': round(sL / sS, 4),
                'frameshift_over_nonSplice': round((sL - sN) / sN, 4),
                'coding_dnm_snv_per_trio': round(2 * (sS + sM + sN), 4),
            },
            '_builtWith': 'scripts/build-dnm-rates-mane.py (offline; needs python + denovonear + MANE GTF + GRCh38 FASTA)',
            'geneCount': len(genes),
            'droppedFailed': dropped,
        },
        'genes': genes,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with gzip.open(OUT, 'wt', encoding='utf-8') as fh:
        json.dump(payload, fh, separators=(',', ':'))
    print(f'\nwrote {os.path.normpath(OUT)}  ({os.path.getsize(OUT):,} bytes, {len(genes):,} genes)')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().split('\n\n')[0] + '\n\nusage: build-dnm-rates-mane.py <denovonear rates output.txt>')
    main(sys.argv[1])
