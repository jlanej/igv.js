import "./utils/mockObjects.js"
import CachedSequence from "../js/genome/cachedSequence.js"
import {assert} from 'chai'

/**
 * Mock sequence reader that returns a predictable sequence string for testing.
 * The returned string encodes the requested coordinates so we can verify correct data is returned.
 */
class MockSequenceReader {

    constructor(delay = 0) {
        this.delay = delay
        this.callCount = 0
        this.chromosomes = new Map()
        this.chromosomes.set("chr1", {bpLength: 10000000})
    }

    async readSequence(chr, start, end) {
        this.callCount++
        if (this.delay > 0) {
            await new Promise(resolve => setTimeout(resolve, this.delay))
        }
        if (chr === "noSuchChr") return null
        // Return a string of length (end - start) filled with 'A'
        const length = end - start
        return 'A'.repeat(length)
    }

    getSequenceRecord(chr) {
        return this.chromosomes.get(chr)
    }
}

suite("testCachedSequenceUnit", function () {

    test("getSequence - basic", async function () {
        const reader = new MockSequenceReader()
        const cached = new CachedSequence(reader)
        const seq = await cached.getSequence("chr1", 100, 200)
        assert.equal(seq.length, 100)
        assert.equal(seq, 'A'.repeat(100))
    })

    test("getSequence - cache hit", async function () {
        const reader = new MockSequenceReader()
        const cached = new CachedSequence(reader)

        // First call populates cache
        await cached.getSequence("chr1", 100, 200)
        assert.equal(reader.callCount, 1)

        // Second call for same region should use cache (no new fetch)
        await cached.getSequence("chr1", 100, 200)
        assert.equal(reader.callCount, 1)

        // Call for sub-region should also use cache
        await cached.getSequence("chr1", 120, 180)
        assert.equal(reader.callCount, 1)
    })

    test("getSequence - null sequence", async function () {
        const reader = new MockSequenceReader()
        const cached = new CachedSequence(reader)
        const seq = await cached.getSequence("noSuchChr", 0, 10)
        assert.isNull(seq)
    })

    test("getSequence - concurrent requests for same region are deduplicated", async function () {
        const reader = new MockSequenceReader(10) // 10ms delay
        const cached = new CachedSequence(reader)

        // Fire multiple concurrent requests for the same region
        const promises = [
            cached.getSequence("chr1", 100, 200),
            cached.getSequence("chr1", 100, 200),
            cached.getSequence("chr1", 100, 200)
        ]
        const results = await Promise.all(promises)

        // All should return the same data
        for (const seq of results) {
            assert.equal(seq.length, 100)
        }

        // Should only have made 1 fetch call (deduplicated)
        assert.equal(reader.callCount, 1)
    })

    test("getSequence - concurrent requests for different regions within same expanded query", async function () {
        const reader = new MockSequenceReader(10)
        const cached = new CachedSequence(reader)

        // Two small requests that fall within the same expanded 100kb query range
        const promises = [
            cached.getSequence("chr1", 1000, 1100),
            cached.getSequence("chr1", 1050, 1150)
        ]
        const results = await Promise.all(promises)

        assert.equal(results[0].length, 100)
        assert.equal(results[1].length, 100)

        // Both should be served by a single expanded query
        assert.equal(reader.callCount, 1)
    })

    test("getSequence - concurrent requests for non-overlapping regions", async function () {
        const reader = new MockSequenceReader(10)
        const cached = new CachedSequence(reader)

        // Two requests for completely different regions (far apart, won't share expanded query)
        const promises = [
            cached.getSequence("chr1", 100000, 300000),
            cached.getSequence("chr1", 5000000, 5200000)
        ]
        const results = await Promise.all(promises)

        assert.equal(results[0].length, 200000)
        assert.equal(results[1].length, 200000)

        // These are far apart and large, so require separate fetches
        assert.equal(reader.callCount, 2)
    })

    test("getSequence - error propagation", async function () {
        const reader = new MockSequenceReader()
        reader.readSequence = async function () {
            throw new Error("Network error")
        }
        const cached = new CachedSequence(reader)

        try {
            await cached.getSequence("chr1", 100, 200)
            assert.fail("Expected error")
        } catch (e) {
            assert.equal(e.message, "Network error")
        }
    })

    test("getSequenceInterval - returns cached interval", async function () {
        const reader = new MockSequenceReader()
        const cached = new CachedSequence(reader)

        // Preload cache
        await cached.getSequence("chr1", 100, 200)

        const interval = cached.getSequenceInterval("chr1", 100, 200)
        assert.ok(interval)
        const seq = interval.getSequence(100, 200)
        assert.equal(seq.length, 100)
    })
})
