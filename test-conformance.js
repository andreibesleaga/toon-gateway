#!/usr/bin/env node
/**
 * TOON Conformance Test Runner
 * Runs official TOON spec tests against the toon-codec implementation
 * ../spec dir must contain tests from https://github.com/toon-format/spec
 */

const fs = require('fs');
const path = require('path');
const { encodeToToon } = require('./src/toon-codec');

const SPEC_DIR = path.join(__dirname, '../spec/tests/fixtures');
const COLORS = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    dim: '\x1b[2m'
};

class TestRunner {
    constructor() {
        this.stats = {
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0
        };
        this.failures = [];
    }

    log(message, color = 'reset') {
        console.log(`${COLORS[color]}${message}${COLORS.reset}`);
    }

    async runEncodeTests() {
        const encodeDir = path.join(SPEC_DIR, 'encode');
        const files = fs.readdirSync(encodeDir).filter(f => f.endsWith('.json'));

        this.log('\n📦 Running Encode Tests (JSON → TOON)\n', 'blue');

        for (const file of files) {
            const fixture = JSON.parse(fs.readFileSync(path.join(encodeDir, file), 'utf8'));
            this.log(`\n  ${file}`, 'dim');
            
            for (const test of fixture.tests) {
                this.stats.total++;
                
                try {
                    // Pass options from test fixture to encoder
                    const result = encodeToToon(test.input, test.options || {});
                    const expected = test.expected;
                    
                    // Normalize whitespace for comparison
                    const normalizedResult = this.normalizeWhitespace(result);
                    const normalizedExpected = this.normalizeWhitespace(expected);
                    
                    if (normalizedResult === normalizedExpected) {
                        this.stats.passed++;
                        this.log(`    ✓ ${test.name}`, 'green');
                    } else {
                        this.stats.failed++;
                        this.failures.push({
                            file,
                            test: test.name,
                            input: test.input,
                            expected,
                            actual: result,
                            note: test.note
                        });
                        this.log(`    ✗ ${test.name}`, 'red');
                        this.log(`      Expected: ${this.truncate(expected)}`, 'dim');
                        this.log(`      Got:      ${this.truncate(result)}`, 'dim');
                    }
                } catch (error) {
                    if (test.shouldError) {
                        this.stats.passed++;
                        this.log(`    ✓ ${test.name} (error expected)`, 'green');
                    } else {
                        this.stats.failed++;
                        this.failures.push({
                            file,
                            test: test.name,
                            input: test.input,
                            error: error.message
                        });
                        this.log(`    ✗ ${test.name}`, 'red');
                        this.log(`      Error: ${error.message}`, 'dim');
                    }
                }
            }
        }
    }

    async runDecodeTests() {
        const { decodeFromToon } = require('./src/toon-codec');
        const decodeDir = path.join(SPEC_DIR, 'decode');
        
        if (!fs.existsSync(decodeDir)) {
            this.log('\n📥 Decode Tests (TOON → JSON)', 'blue');
            this.log('  ⚠️  Decode test directory not found - skipping', 'yellow');
            return;
        }

        const files = fs.readdirSync(decodeDir).filter(f => f.endsWith('.json'));

        this.log('\n📥 Running Decode Tests (TOON → JSON)\n', 'blue');

        for (const file of files) {
            const fixture = JSON.parse(fs.readFileSync(path.join(decodeDir, file), 'utf8'));
            this.log(`\n  ${file}`, 'dim');
            
            for (const test of fixture.tests) {
                this.stats.total++;
                
                try {
                    const result = decodeFromToon(test.input, test.options || {});
                    const expected = test.expected;
                    
                    // Deep equality comparison
                    if (JSON.stringify(result) === JSON.stringify(expected)) {
                        this.stats.passed++;
                        this.log(`    ✓ ${test.name}`, 'green');
                    } else {
                        this.stats.failed++;
                        this.failures.push({
                            file,
                            test: test.name,
                            input: test.input,
                            expected,
                            actual: result,
                            note: test.note
                        });
                        this.log(`    ✗ ${test.name}`, 'red');
                        this.log(`      Expected: ${this.truncate(JSON.stringify(expected))}`, 'dim');
                        this.log(`      Got:      ${this.truncate(JSON.stringify(result))}`, 'dim');
                    }
                } catch (error) {
                    if (test.shouldError) {
                        this.stats.passed++;
                        this.log(`    ✓ ${test.name} (error expected)`, 'green');
                    } else {
                        this.stats.failed++;
                        this.failures.push({
                            file,
                            test: test.name,
                            input: test.input,
                            error: error.message
                        });
                        this.log(`    ✗ ${test.name}`, 'red');
                        this.log(`      Error: ${error.message}`, 'dim');
                    }
                }
            }
        }
    }

    normalizeWhitespace(str) {
        // Normalize line endings and trailing whitespace
        return str.replace(/\r\n/g, '\n').trim();
    }

    truncate(str, maxLen = 100) {
        const s = String(str).replace(/\n/g, '\\n');
        return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
    }

    printSummary() {
        this.log('\n' + '='.repeat(60), 'dim');
        this.log('Test Summary', 'blue');
        this.log('='.repeat(60), 'dim');
        
        const passRate = ((this.stats.passed / this.stats.total) * 100).toFixed(1);
        
        this.log(`Total:   ${this.stats.total}`);
        this.log(`Passed:  ${this.stats.passed}`, 'green');
        this.log(`Failed:  ${this.stats.failed}`, this.stats.failed > 0 ? 'red' : 'reset');
        this.log(`Skipped: ${this.stats.skipped}`, 'yellow');
        this.log(`\nPass Rate: ${passRate}%`, passRate === '100.0' ? 'green' : 'yellow');

        if (this.failures.length > 0) {
            this.log('\n' + '='.repeat(60), 'dim');
            this.log('Failures Detail', 'red');
            this.log('='.repeat(60), 'dim');
            
            this.failures.slice(0, 10).forEach((failure, i) => {
                this.log(`\n${i + 1}. ${failure.test} (${failure.file})`, 'red');
                this.log(`   Input: ${JSON.stringify(failure.input)}`, 'dim');
                if (failure.expected) {
                    this.log(`   Expected: ${this.truncate(failure.expected)}`, 'dim');
                    this.log(`   Got:      ${this.truncate(failure.actual)}`, 'dim');
                }
                if (failure.error) {
                    this.log(`   Error: ${failure.error}`, 'dim');
                }
                if (failure.note) {
                    this.log(`   Note: ${failure.note}`, 'dim');
                }
            });

            if (this.failures.length > 10) {
                this.log(`\n... and ${this.failures.length - 10} more failures`, 'dim');
            }
        }

        this.log('');
        return this.stats.failed === 0 ? 0 : 1;
    }

    async run() {
        try {
            // Check if spec directory exists
            if (!fs.existsSync(SPEC_DIR)) {
                this.log(`\n❌ Spec directory not found: ${SPEC_DIR}`, 'red');
                this.log('Please ensure the spec repository is cloned at ../spec', 'yellow');
                return 1;
            }

            this.log('╔═══════════════════════════════════════════════════════╗', 'blue');
            this.log('║        TOON Format Conformance Test Suite            ║', 'blue');
            this.log('╚═══════════════════════════════════════════════════════╝', 'blue');

            await this.runEncodeTests();
            await this.runDecodeTests();

            return this.printSummary();
        } catch (error) {
            this.log(`\n❌ Test runner error: ${error.message}`, 'red');
            console.error(error);
            return 1;
        }
    }
}

// Run tests
if (require.main === module) {
    const runner = new TestRunner();
    runner.run().then(exitCode => process.exit(exitCode));
}

module.exports = TestRunner;
