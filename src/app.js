require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const { redis, generateKey, isRedisConnected } = require('./cache');
const { encodeToToon } = require('./toon-codec');
const winston = require('winston');

// Logger Configuration
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' })
    ]
});

// Console logging in development
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        )
    }));
}

const app = express();
const PORT = process.env.PORT || 3000;
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'https://jsonplaceholder.typicode.com';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '300', 10);

// Security Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"]
        }
    }
}));

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(limiter);
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
app.use(compression());

// Health Check Endpoint
app.get('/health', async (req, res) => {
    const health = {
        status: 'healthy',
        uptime: process.uptime(),
        redis: isRedisConnected() ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    };
    
    const statusCode = health.redis === 'connected' ? 200 : 503;
    res.status(statusCode).json(health);
});

// Cache Middleware
const cacheMiddleware = async (req, res, next) => {
    if (req.method !== 'GET') return next();
    
    // Skip cache for health check
    if (req.path === '/health') return next();
    
    if (!isRedisConnected()) {
        logger.warn('Redis not connected, skipping cache check');
        res.setHeader('X-Cache', 'UNAVAILABLE');
        return next();
    }
    
    const key = generateKey(req);
    try {
        const cachedData = await redis.get(key);
        if (cachedData) {
            logger.debug(`Cache HIT for ${key}`);
            res.setHeader('X-Cache', 'HIT');
            res.setHeader('Content-Type', 'text/toon; charset=utf-8');
            return res.send(cachedData);
        }
        logger.debug(`Cache MISS for ${key}`);
        res.setHeader('X-Cache', 'MISS');
        next();
    } catch (err) {
        logger.error('Cache retrieval error:', err);
        res.setHeader('X-Cache', 'ERROR');
        next();
    }
};

// Proxy Logic
const proxyOptions = {
    target: UPSTREAM_URL,
    changeOrigin: true,
    selfHandleResponse: true,
    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        const contentType = proxyRes.headers['content-type'];
        
        // Detect JSON
        if (contentType && contentType.includes('application/json')) {
            try {
                const rawBody = responseBuffer.toString('utf8');
                const jsonBody = JSON.parse(rawBody);
                
                logger.debug(`Transforming JSON response for ${req.originalUrl}`);
                
                // Convert
                const toonBody = encodeToToon(jsonBody);

                // Cache (only if Redis is connected)
                if (req.method === 'GET' && res.statusCode === 200 && isRedisConnected()) {
                    try {
                        await redis.set(generateKey(req), toonBody, 'EX', CACHE_TTL);
                        logger.debug(`Cached response for ${generateKey(req)}`);
                    } catch (cacheErr) {
                        logger.error('Failed to cache response:', cacheErr);
                    }
                }

                res.setHeader('Content-Type', 'text/toon; charset=utf-8');
                res.removeHeader('content-length');
                res.removeHeader('etag');
                
                return toonBody;
            } catch (err) {
                logger.error('Transformation Failed:', err);
                return responseBuffer;
            }
        }
        return responseBuffer;
    }),
    onError: (err, req, res) => {
        logger.error('Proxy Error:', err);
        res.status(502).json({
            error: 'Bad Gateway',
            message: 'Unable to reach upstream service'
        });
    }
};

app.use('/', cacheMiddleware, createProxyMiddleware(proxyOptions));

// Error Handler
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message
    });
});

// Graceful Shutdown
const server = app.listen(PORT, () => {
    logger.info(`TOON Gateway running on port ${PORT}`);
    logger.info(`Proxying to: ${UPSTREAM_URL}`);
    logger.info(`Cache TTL: ${CACHE_TTL}s`);
    logger.info(`Security: Helmet + Rate Limiting enabled`);
});

process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    server.close(() => {
        logger.info('Server closed');
        redis.quit();
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    server.close(() => {
        logger.info('Server closed');
        redis.quit();
        process.exit(0);
    });
});
