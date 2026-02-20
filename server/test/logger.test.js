const {describe, it} = require('mocha')
const {expect} = require('chai')

const logger = require('../logger')

describe('Logger', function () {
    it('exports debug, info, warn, error methods', function () {
        expect(logger).to.have.property('debug').that.is.a('function')
        expect(logger).to.have.property('info').that.is.a('function')
        expect(logger).to.have.property('warn').that.is.a('function')
        expect(logger).to.have.property('error').that.is.a('function')
    })

    it('exports requestLogger middleware', function () {
        expect(logger).to.have.property('requestLogger').that.is.a('function')
    })

    it('requestLogger calls next()', function (done) {
        const req = {method: 'GET', originalUrl: '/test'}
        const res = {on: () => {}, statusCode: 200}
        logger.requestLogger(req, res, done)
    })

    it('requestLogger logs on response finish', function (done) {
        const req = {method: 'GET', originalUrl: '/test'}
        let finishCb
        const res = {on: (event, cb) => { if (event === 'finish') finishCb = cb }, statusCode: 200}
        logger.requestLogger(req, res, () => {
            // Trigger the finish event; logger.info should not throw
            finishCb()
            done()
        })
    })
})
