---
description: Check and configure load and performance testing with k6. Audits existing tests, generates compliance report, and fixes configuration issues.
---

# configure-load-tests

Check and configure load and performance testing infrastructure for stress testing, benchmarking, and capacity planning.

## When to Use This Prompt

Use when:
- Setting up load testing infrastructure from scratch (k6)
- Auditing current load testing coverage (smoke, stress, spike, soak, peak)
- Adding CI/CD pipelines for performance regression detection
- Ensuring load test thresholds and reporting are properly configured
- Fixing existing tests that may not be measuring correctly

Do NOT use when:
- Running existing load tests — run `k6 run` directly
- Writing unit or integration tests
- Profiling application memory usage

## Parameters (include in your message)

- `--check-only` → Report compliance status without modifying anything
- `--fix` → Apply all fixes automatically without prompting
- `--framework k6|artillery|locust` → Override framework detection (default: k6)

## Instructions

### Step 1: Scan the project for existing load testing infrastructure

Look for:
- `*.k6.js` or `*.k6.ts` files anywhere in the project
- Directories named `load`, `load-tests`, or `performance`
- `artillery.yml` or `artillery.yaml`
- `locustfile.py`
- `package.json` scripts containing `k6`, `artillery`, or `locust`
- `.github/workflows/` files related to load or performance testing

### Step 2: Analyze current setup

Check for complete coverage across these areas:

**Test Scenarios** — verify which exist:
- Smoke test (1 VU, 30s — minimal validation)
- Load test (50 VUs, ~9m — normal load)
- Stress test (50→200 VUs, ~26m — find breaking points)
- Spike test (10→500 VUs, ~7m — burst traffic)
- Soak test (100 VUs, ~2h — endurance)
- Peak test (if present — verify it matches expected peak load)

**For each test that exists, verify:**
- Thresholds are configured (http_req_failed, http_req_duration p95/p99)
- It targets the correct endpoints for THIS project (not generic /api/products or /api/users placeholders)
- VU counts and durations make sense for a booking/appointment system
- Auth headers are properly handled if endpoints require authentication
- handleSummary exports results to JSON/HTML

**Configuration:**
- `tests/load/config/base.js` with shared thresholds and BASE_URL
- Environment configs for staging and production
- Helper files for auth and test data generation

**CI/CD:**
- `.github/workflows/load-tests.yml` with smoke on PR, full tests on dispatch
- Scheduled runs
- Results artifact upload

### Step 3: Generate compliance report

Print a report in this format:

```
Load Testing Compliance Report
===============================
Project: [detected project name]
Framework: k6

Installation:
  k6 binary/npm              [INSTALLED | MISSING]
  TypeScript support         [INSTALLED | OPTIONAL]

Test Scenarios:
  Smoke test                 [EXISTS | MISSING]
  Load test                  [EXISTS | MISSING]
  Stress test                [EXISTS | MISSING]
  Spike test                 [EXISTS | MISSING]
  Soak test                  [EXISTS | MISSING]

Test Quality:
  Endpoints match project    [OK | GENERIC PLACEHOLDERS FOUND]
  Thresholds configured      [OK | MISSING]
  Auth handled               [OK | MISSING]
  Results exported           [OK | MISSING]

Configuration:
  base.js config             [EXISTS | MISSING]
  Environment configs        [EXISTS | MISSING]

CI/CD Integration:
  GitHub Actions workflow    [CONFIGURED | MISSING]
  Scheduled runs             [CONFIGURED | MISSING]
  PR gate (smoke)            [CONFIGURED | MISSING]

Reporting:
  JSON export                [CONFIGURED | MISSING]
  HTML report                [CONFIGURED | MISSING]

Issues found: [X]
```

If `--check-only` is set, STOP HERE. Do not modify any files.

### Step 4: Fix issues (only if `--fix` or user confirms)

Use the templates in `load-testing-reference.prompt.md` to:

1. Create directory structure: `tests/load/{config,scenarios,helpers,data}`
2. Create or fix `base.js` with shared thresholds
3. Create or fix missing test scenarios
4. **IMPORTANT**: Replace generic endpoint placeholders (`/api/products`, `/api/users`, `/api/orders`) with the actual endpoints of this project. Ask the user if unsure.
5. Add npm scripts to `package.json`
6. Create `.github/workflows/load-tests.yml`
7. Update `.project-standards.yaml` if it exists

### Step 5: Print final summary

After applying fixes, print what was created/modified and suggested next steps.

## Usage Examples

```
# Audit only, no changes
/configure-load-tests --check-only

# Auto-fix everything
/configure-load-tests --fix

# Audit and fix with specific framework
/configure-load-tests --fix --framework k6
```

## Reference

For k6 script templates, CI workflow templates, and reporting configuration, see `load-testing-reference.prompt.md`.
