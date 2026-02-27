#!/usr/bin/env node

/**
 * Parse an annotated VCF (from kmer_denovo_filter) into the TSV format
 * expected by the IGV Variant Review Server.
 *
 * Usage:
 *   node vcf_to_variants_tsv.js \
 *     --vcf  annotated.vcf.gz \
 *     --child-bam  HG002_child.bam \
 *     --mother-bam HG003_father.bam \
 *     --father-bam HG004_mother.bam \
 *     --output     variants.tsv
 *
 * The VCF is expected to have FORMAT fields: GT, AD, GQ, DKA, DKT
 * (produced by kmer_denovo_filter: https://github.com/jlanej/kmer_denovo_filter).
 */

const fs = require('fs')
const {execSync} = require('child_process')
const path = require('path')

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
function getArg(name, defaultValue) {
    const idx = args.indexOf(`--${name}`)
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultValue
}

const VCF_PATH = getArg('vcf', null)
const CHILD_BAM = getArg('child-bam', null)
const MOTHER_BAM = getArg('mother-bam', null)
const FATHER_BAM = getArg('father-bam', null)
const OUTPUT = getArg('output', null)

/**
 * Parse the FORMAT and sample columns of a VCF record.
 * Returns an object keyed by FORMAT field name → sample value.
 */
function parseSampleFields(formatStr, sampleStr) {
    const keys = formatStr.split(':')
    const vals = sampleStr.split(':')
    const obj = {}
    keys.forEach((k, i) => { obj[k] = vals[i] || '.' })
    return obj
}

/**
 * Determine inheritance status from genotype and DKU.
 * A variant is "de_novo" when DKU > 0, otherwise "inherited".
 */
function classifyInheritance(fields) {
    const dku = parseInt(fields.DKU || '0', 10)
    return dku > 0 ? 'de_novo' : 'inherited'
}

/**
 * Read VCF lines from a gzipped or plain VCF file.
 * Uses zgrep/zcat for .gz files, plain read otherwise.
 */
function readVcfLines(vcfPath) {
    const isGz = vcfPath.endsWith('.gz')
    let raw
    if (isGz) {
        raw = execSync(`zcat "${vcfPath}"`, {maxBuffer: 50 * 1024 * 1024}).toString()
    } else {
        raw = fs.readFileSync(vcfPath, 'utf-8')
    }
    return raw.trim().split('\n')
}

/**
 * Convert an annotated VCF into the review-server TSV format.
 *
 * @param {object} opts
 * @param {string} opts.vcfPath   – path to annotated VCF (plain or .gz)
 * @param {string} opts.childBam  – filename for child BAM/CRAM
 * @param {string} opts.motherBam – filename for mother BAM/CRAM
 * @param {string} opts.fatherBam – filename for father BAM/CRAM
 * @returns {string} TSV content
 */
function vcfToTsv({vcfPath, childBam, motherBam, fatherBam}) {
    const lines = readVcfLines(vcfPath)
    const dataLines = lines.filter(l => !l.startsWith('#'))

    const header = [
        'chrom', 'pos', 'ref', 'alt',
        'gene', 'impact', 'frequency', 'inheritance', 'quality',
        'child_gt', 'mother_gt', 'father_gt',
        'child_AD', 'mother_AD', 'father_AD',
        'child_GQ', 'mother_GQ', 'father_GQ',
        'child_DKA_DKT',
        'child_file', 'mother_file', 'father_file'
    ]

    const rows = [header.join('\t')]

    for (const line of dataLines) {
        const cols = line.split('\t')
        if (cols.length < 10) continue

        const chrom = cols[0]
        const pos = cols[1]
        const ref = cols[3]
        const alt = cols[4]
        const qual = cols[5]
        const formatStr = cols[8]
        const sampleStr = cols[9]

        const fields = parseSampleFields(formatStr, sampleStr)

        const gt = fields.GT || '.'
        const ad = fields.AD || '.'
        const gq = fields.GQ || '.'
        const dka = fields.DKA || '0'
        const dkt = fields.DKT || '0'

        const inheritance = classifyInheritance(fields)

        // For a single-sample VCF (child only), parents are ref/ref
        const childAD = ad
        const motherAD = '.'
        const fatherAD = '.'
        const motherGT = '0/0'
        const fatherGT = '0/0'
        const motherGQ = '.'
        const fatherGQ = '.'

        const dkaDkt = dkt !== '0' ? `${dka}/${dkt}` : '0/0'

        const row = [
            chrom, pos, ref, alt,
            '',           // gene (not in VCF)
            '',           // impact (not in VCF)
            '0',          // frequency (not in VCF)
            inheritance,
            qual,
            gt, motherGT, fatherGT,
            childAD, motherAD, fatherAD,
            gq, motherGQ, fatherGQ,
            dkaDkt,
            childBam, motherBam, fatherBam
        ]

        rows.push(row.join('\t'))
    }

    return rows.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
    if (!VCF_PATH) {
        console.error('Usage: node vcf_to_variants_tsv.js --vcf <path> [--child-bam <file>] [--mother-bam <file>] [--father-bam <file>] [--output <path>]')
        process.exit(1)
    }
    const tsv = vcfToTsv({
        vcfPath: VCF_PATH,
        childBam: CHILD_BAM || 'child.bam',
        motherBam: MOTHER_BAM || 'mother.bam',
        fatherBam: FATHER_BAM || 'father.bam'
    })
    if (OUTPUT) {
        fs.writeFileSync(OUTPUT, tsv, 'utf-8')
        console.log(`Wrote ${tsv.split('\n').length - 2} variants to ${OUTPUT}`)
    } else {
        process.stdout.write(tsv)
    }
}

module.exports = {vcfToTsv, parseSampleFields, classifyInheritance}
