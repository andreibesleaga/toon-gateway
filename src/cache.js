const Redis = require('ioredis');

let redisConnected = false;

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    reconnectOnError(err) {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
            return true;
        }
        return false;
    }
});

redis.on('error', (err) => {
    console.error('Redis Client Error:', err.message);
    redisConnected = false;
});

redis.on('connect', () => {
    console.log('Connected to Redis Cache');
    redisConnected = true;
});

redis.on('ready', () => {
    console.log('Redis is ready to accept commands');
    redisConnected = true;
});

redis.on('close', () => {
    console.warn('Redis connection closed');
    redisConnected = false;
});

redis.on('reconnecting', () => {
    console.log('Reconnecting to Redis...');
    redisConnected = false;
});

const generateKey = (req) => `toon_cache:${req.method}:${req.originalUrl}`;

const isRedisConnected = () => redisConnected;

module.exports = { redis, generateKey, isRedisConnected };
