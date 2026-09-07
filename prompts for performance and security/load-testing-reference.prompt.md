---
description: Reference templates for k6 load testing — scripts, CI workflows, directory structure, and reporting configuration. Used by configure-load-tests.prompt.md.
---

# Load Testing Configuration Reference

Detailed k6 test scripts, CI workflow templates, directory structure, and reporting configuration.

## k6 Installation

```bash
# macOS
brew install k6

# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6

# Docker
docker pull grafana/k6

# Or via npm (for CI)
npm install -g @grafana/k6
```

**TypeScript support:**
```bash
bun add --dev @types/k6
```

## Directory Structure

```
tests/
└── load/
    ├── config/
    │   ├── base.js           # Shared configuration
    │   ├── staging.js        # Staging environment
    │   └── production.js     # Production environment
    ├── scenarios/
    │   ├── smoke.k6.js       # Minimal load validation
    │   ├── load.k6.js        # Normal load testing
    │   ├── stress.k6.js      # Find breaking points
    │   ├── spike.k6.js       # Burst traffic
    │   └── soak.k6.js        # Endurance testing
    ├── helpers/
    │   ├── auth.js           # Authentication helpers
    │   └── data.js           # Test data generation
    └── data/
        └── users.json        # Test data files
```

## Base Configuration

**`tests/load/config/base.js`:**
```javascript
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const thresholds = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<500'],
  'http_req_duration{expected_response:true}': ['p(99)<1500'],
};

export const headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

export function getAuthHeaders(token) {
  return {
    ...headers,
    'Authorization': `Bearer ${token}`,
  };
}
```

## Test Scenarios

### Smoke Test

**`tests/load/scenarios/smoke.k6.js`:**
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, thresholds, headers } from '../config/base.js';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    ...thresholds,
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.001'],
  },
  tags: { test_type: 'smoke' },
};

export default function () {
  const healthRes = http.get(`${BASE_URL}/health`, { headers });
  check(healthRes, {
    'health check status is 200': (r) => r.status === 200,
    'health check response time < 100ms': (r) => r.timings.duration < 100,
  });
  sleep(1);
}

export function setup() {
  console.log(`Starting smoke test against ${BASE_URL}`);
  const res = http.get(`${BASE_URL}/health`);
  if (res.status !== 200) {
    throw new Error(`Target not reachable: ${res.status}`);
  }
  return { startTime: new Date().toISOString() };
}

export function teardown(data) {
  console.log(`Smoke test completed. Started at: ${data.startTime}`);
}
```

### Load Test

**`tests/load/scenarios/load.k6.js`:**
```javascript
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { BASE_URL, thresholds, headers, getAuthHeaders } from '../config/base.js';

const apiErrors = new Counter('api_errors');
const successRate = new Rate('success_rate');
const bookingCreationTime = new Trend('booking_creation_time');

export const options = {
  stages: [
    { duration: '2m', target: 50 },   // Ramp up
    { duration: '5m', target: 50 },   // Steady state
    { duration: '2m', target: 0 },    // Ramp down
  ],
  thresholds: {
    ...thresholds,
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    success_rate: ['rate>0.95'],
    api_errors: ['count<100'],
  },
  tags: { test_type: 'load' },
};

export default function () {
  // Replace these groups with the actual flows of your booking system
  group('List Available Slots', () => {
    const res = http.get(`${BASE_URL}/api/slots`, { headers });
    const success = check(res, {
      'slots status is 200': (r) => r.status === 200,
    });
    successRate.add(success);
    if (!success) apiErrors.add(1);
    sleep(1);
  });

  group('Create Booking', () => {
    const startTime = Date.now();
    const res = http.post(
      `${BASE_URL}/api/bookings`,
      JSON.stringify({ slotId: '123', userId: `user${__VU}` }),
      { headers }
    );
    bookingCreationTime.add(Date.now() - startTime);
    const success = check(res, {
      'booking created': (r) => r.status === 201,
    });
    successRate.add(success);
    if (!success) apiErrors.add(1);
    sleep(1);
  });

  sleep(Math.random() * 3 + 1);
}

export function handleSummary(data) {
  return {
    'results/load-test-summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  };
}
```

### Stress Test

**`tests/load/scenarios/stress.k6.js`:**
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, headers } from '../config/base.js';

export const options = {
  stages: [
    { duration: '2m', target: 50 },
    { duration: '5m', target: 50 },
    { duration: '2m', target: 100 },
    { duration: '5m', target: 100 },
    { duration: '2m', target: 200 },
    { duration: '5m', target: 200 },
    { duration: '5m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.10'],
    http_req_duration: ['p(95)<2000'],
  },
  tags: { test_type: 'stress' },
};

export default function () {
  const responses = http.batch([
    ['GET', `${BASE_URL}/api/slots`, null, { headers }],
    ['GET', `${BASE_URL}/api/services`, null, { headers }],
    ['GET', `${BASE_URL}/api/staff`, null, { headers }],
  ]);

  responses.forEach((res, i) => {
    check(res, {
      [`batch request ${i} succeeded`]: (r) => r.status === 200,
    });
  });

  sleep(1);
}
```

### Spike Test

**`tests/load/scenarios/spike.k6.js`:**
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, headers } from '../config/base.js';

export const options = {
  stages: [
    { duration: '1m', target: 10 },
    { duration: '30s', target: 500 },
    { duration: '1m', target: 500 },
    { duration: '30s', target: 10 },
    { duration: '2m', target: 10 },
    { duration: '30s', target: 500 },
    { duration: '1m', target: 500 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.15'],
    http_req_duration: ['p(95)<3000'],
  },
  tags: { test_type: 'spike' },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/slots`, { headers });
  check(res, {
    'status is 200 or 503': (r) => [200, 503].includes(r.status),
    'response time acceptable': (r) => r.timings.duration < 5000,
  });
  sleep(0.5);
}
```

### Soak Test

**`tests/load/scenarios/soak.k6.js`:**
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, headers } from '../config/base.js';

export const options = {
  stages: [
    { duration: '5m', target: 100 },
    { duration: '2h', target: 100 },
    { duration: '5m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
  },
  tags: { test_type: 'soak' },
};

export default function () {
  const endpoints = [
    '/api/slots',
    '/api/services',
    '/api/staff',
    '/api/bookings',
  ];

  const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
  const res = http.get(`${BASE_URL}${endpoint}`, { headers });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'consistent response time': (r) => r.timings.duration < 500,
  });

  sleep(Math.random() * 5 + 2);
}
```

## CI/CD Workflow

**`.github/workflows/load-tests.yml`:**

```yaml
name: Load Tests

on:
  workflow_dispatch:
    inputs:
      test_type:
        description: 'Test type to run'
        required: true
        default: 'smoke'
        type: choice
        options:
          - smoke
          - load
          - stress
          - spike
          - soak
      environment:
        description: 'Target environment'
        required: true
        default: 'staging'
        type: choice
        options:
          - staging
          - production

  pull_request:
    paths:
      - 'src/**'
      - 'tests/load/**'

  schedule:
    - cron: '0 3 * * 1'  # Weekly on Monday at 3 AM

jobs:
  smoke-test:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install k6
        run: |
          sudo gpg -k
          sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
          echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
          sudo apt-get update
          sudo apt-get install k6

      - name: Start application
        run: |
          docker compose up -d
          sleep 30

      - name: Run smoke test
        run: k6 run tests/load/scenarios/smoke.k6.js
        env:
          BASE_URL: http://localhost:3000

      - name: Upload results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: smoke-test-results
          path: results/

  load-test:
    if: github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'
    runs-on: ubuntu-latest
    environment: ${{ github.event.inputs.environment || 'staging' }}
    steps:
      - uses: actions/checkout@v4

      - name: Install k6
        run: |
          sudo gpg -k
          sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
          echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
          sudo apt-get update
          sudo apt-get install k6

      - name: Run load test
        run: |
          TEST_TYPE=${{ github.event.inputs.test_type || 'load' }}
          k6 run tests/load/scenarios/${TEST_TYPE}.k6.js \
            --out json=results/${TEST_TYPE}-results.json
        env:
          BASE_URL: ${{ vars.LOAD_TEST_URL }}

      - name: Upload results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: load-test-results
          path: results/
```

## npm Scripts

```json
{
  "scripts": {
    "test:load:smoke": "k6 run tests/load/scenarios/smoke.k6.js",
    "test:load": "k6 run tests/load/scenarios/load.k6.js",
    "test:load:stress": "k6 run tests/load/scenarios/stress.k6.js",
    "test:load:spike": "k6 run tests/load/scenarios/spike.k6.js",
    "test:load:soak": "k6 run tests/load/scenarios/soak.k6.js",
    "test:load:all": "k6 run tests/load/scenarios/smoke.k6.js && k6 run tests/load/scenarios/load.k6.js"
  }
}
```

## HTML Reporting

```javascript
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

export function handleSummary(data) {
  return {
    'results/summary.html': htmlReport(data),
    'results/summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  };
}
```

## Load Testing Types Reference

| Type  | Purpose                        | VUs     | Duration  |
|-------|--------------------------------|---------|-----------|
| Smoke | Verify system works at min load | 1       | 30s       |
| Load  | Expected normal load           | 50      | ~9m       |
| Stress| Find breaking points           | 50-200  | ~26m      |
| Spike | Sudden traffic bursts          | 10-500  | ~7m       |
| Soak  | Extended duration stability    | 100     | ~2h10m    |
