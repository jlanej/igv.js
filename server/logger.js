/**
 * Lightweight logger with levels, timestamps, and terminal-friendly output.
 *
 * Log level is controlled via the --log-level CLI flag (default: "info").
 * Levels: debug < info < warn < error
 *
 * Usage:
 *   const log = require('./logger')
 *   log.info('Server started on port', 3000)
 *   log.error('Something went wrong:', err.message)
 */

const LEVELS = {debug: 0, info: 1, warn: 2, error: 3}

// Parse --log-level from process.argv
function parseLogLevel() {
    const args = process.argv.slice(2)
    const idx = args.indexOf('--log-level')
    if (idx !== -1 && idx + 1 < args.length) {
        const val = args[idx + 1].toLowerCase()
        if (val in LEVELS) return val
    }
    return 'info'
}

const currentLevel = parseLogLevel()

function timestamp() {
    return new Date().toISOString()
}

function shouldLog(level) {
    return LEVELS[level] >= LEVELS[currentLevel]
}

function formatMessage(level, args) {
    const tag = level.toUpperCase().padEnd(5)
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    return `${timestamp()} [${tag}] ${msg}`
}

const logger = {
    debug(...args) {
        if (shouldLog('debug')) process.stdout.write(formatMessage('debug', args) + '\n')
    },
    info(...args) {
        if (shouldLog('info')) process.stdout.write(formatMessage('info', args) + '\n')
    },
    warn(...args) {
        if (shouldLog('warn')) process.stderr.write(formatMessage('warn', args) + '\n')
    },
    error(...args) {
        if (shouldLog('error')) process.stderr.write(formatMessage('error', args) + '\n')
    },
    /** Express middleware that logs each request. */
    requestLogger(req, res, next) {
        const start = Date.now()
        res.on('finish', () => {
            const duration = Date.now() - start
            logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`)
        })
        next()
    }
}

module.exports = logger
