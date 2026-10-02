import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import onecall from '../core/onecall.js'

// cspell:words Pluie attendue

const { fetchOnecall } = onecall
const config = {
  apikey: 'test-key',
  latitude: 0,
  longitude: 0,
  units: 'metric',
  language: 'fr',
  exclude: 'minutely',
}
const response = body => ({ ok: true, json: async () => body })
const records = (start, count) => Array.from({ length: count }, (_, index) => ({ dt: start + index }))

describe('One Call API adapter', () => {
  it('assembles 4.0 sections, follows hourly pages, and resolves unique localized alerts', async () => {
    const requests = []
    const data = await fetchOnecall(config, async (url) => {
      requests.push(url)
      assert.equal(url.searchParams.get('appid'), config.apikey)
      if (url.pathname.includes('/alert/')) {
        return response({
          event: '',
          tags: ['Rain'],
          description: [
            { language: 'en-GB', description: 'Rain expected' },
            { language: 'fr-FR', description: 'Pluie attendue' },
          ],
        })
      }
      assert.equal(url.searchParams.get('lat'), '0')
      assert.equal(url.searchParams.get('lon'), '0')
      assert.equal(url.searchParams.get('units'), 'metric')
      assert.equal(url.searchParams.get('lang'), 'fr')
      assert.equal(url.searchParams.has('exclude'), false)
      const metadata = { lat: 0, lon: 0, timezone: 'UTC', timezone_offset: 0 }
      if (url.pathname.endsWith('/current')) {
        return response({ ...metadata, data: [{ dt: 1, temp: 12, alerts: ['rain'] }] })
      }
      if (url.pathname.endsWith('/1day')) {
        return response({ ...metadata, data: records(1, 10), next: `${url}&start=11` })
      }
      assert.ok(url.pathname.endsWith('/1h'))
      const start = Number(url.searchParams.get('start') || 1)
      return response({
        ...metadata,
        data: records(start, 20).map(record => ({ ...record, alerts: ['rain'] })),
        next: `https://api.openweathermap.org/data/4.0/onecall/timeline/1h?start=${start + 20}`,
      })
    })
    assert.equal(requests.length, 6)
    assert.equal(data.timezone_offset, 0)
    assert.equal(data.current.temp, 12)
    assert.equal(data.hourly.length, 48)
    assert.equal(data.hourly[47].dt, 48)
    assert.equal(data.daily.length, 8)
    assert.equal(data.minutely, undefined)
    assert.equal(data.alerts.length, 1)
    assert.equal(data.alerts[0].description, 'Pluie attendue')
    assert.equal(data.alerts[0].event, 'Rain')
  })

  it('honors exclusions and can request minute forecasts alone', async () => {
    const urls = []
    const data = await fetchOnecall({ ...config, exclude: ' current, hourly,daily, alerts' }, async (url) => {
      urls.push(url)
      return response({ data: [{ dt: 1, precipitation: 0, alerts: ['rain'] }] })
    })
    assert.equal(urls.length, 1)
    assert.ok(urls[0].pathname.endsWith('/timeline/1min'))
    assert.equal(data.minutely[0].precipitation, 0)
    assert.equal(data.current, undefined)
    assert.equal(data.alerts, undefined)
  })

  it('skips alert details when hidden and maps Kelvin to standard units', async () => {
    let calls = 0
    const data = await fetchOnecall({ ...config, units: 'kelvin', exclude: 'minutely,hourly,daily', showAlerts: false }, async (url) => {
      calls += 1
      assert.equal(url.searchParams.get('units'), 'standard')
      return response({ data: [{ dt: 1, alerts: ['rain'] }] })
    })
    assert.equal(calls, 1)
    assert.equal(data.alerts, undefined)
  })

  it('keeps explicit 3.0 requests and their response format', async () => {
    const body = { current: { dt: 1 }, daily: [] }
    const data = await fetchOnecall({ ...config, apiVersion: '3.0' }, async (url) => {
      assert.equal(url.pathname, '/data/3.0/onecall')
      assert.equal(url.searchParams.get('exclude'), 'minutely')
      return response(body)
    })
    assert.equal(data, body)
  })

  it('propagates HTTP, JSON, and malformed response errors', async () => {
    const currentOnly = { ...config, exclude: 'minutely,hourly,daily' }
    await assert.rejects(fetchOnecall(currentOnly, async () => ({ ok: false, status: 401, statusText: 'Unauthorized' })), /HTTP 401/)
    await assert.rejects(fetchOnecall(currentOnly, async () => ({
      ok: true,
      json: async () => {
        throw new Error('Invalid JSON')
      },
    })), /Invalid JSON/)
    for (const body of [{}, { data: [] }]) {
      await assert.rejects(fetchOnecall(currentOnly, async () => response(body)), /Invalid One Call 4.0 response/)
    }
  })

  it('stops at the last page even if the forecast is shorter than requested', async () => {
    const data = await fetchOnecall({ ...config, exclude: 'current,minutely,daily' }, async () => response({ data: records(1, 3) }))
    assert.equal(data.hourly.length, 3)
  })

  it('excludes minutely and hourly by default', async () => {
    const requestedPaths = []
    const data = await fetchOnecall(
      { apikey: 'k', latitude: 0, longitude: 0, showAlerts: false },
      async (url) => {
        requestedPaths.push(url.pathname)
        return response({ data: [{ dt: 1, temp: 20 }] })
      },
    )
    assert.deepEqual(requestedPaths, [
      '/data/4.0/onecall/current',
      '/data/4.0/onecall/timeline/1day',
    ])
    assert.ok(data.current)
    assert.ok(data.daily)
    assert.equal(data.hourly, undefined)
    assert.equal(data.minutely, undefined)
  })

  it('skips sections when showCurrent or showForecast is false', async () => {
    const requestedPaths = []
    await fetchOnecall(
      { apikey: 'k', latitude: 0, longitude: 0, showCurrent: false, showForecast: false, showAlerts: false },
      async (url) => {
        requestedPaths.push(url.pathname)
        return response({ data: [{ dt: 1 }] })
      },
    )
    assert.deepEqual(requestedPaths, [])
  })

  it('retries on transient HTTP 504 and succeeds after backoff', async () => {
    let attempts = 0
    const data = await fetchOnecall(
      { ...config, exclude: 'minutely,hourly,daily', requestBackoff: 1 },
      async () => {
        attempts += 1
        if (attempts === 1) {
          return { ok: false, status: 504, statusText: 'Gateway Time-out' }
        }
        return response({ data: [{ dt: 1, temp: 15 }] })
      },
    )
    assert.equal(attempts, 2)
    assert.equal(data.current.temp, 15)
  })

  it('retries on request timeout and succeeds after backoff', async () => {
    let attempts = 0
    const data = await fetchOnecall(
      { ...config, exclude: 'minutely,hourly,daily', requestTimeout: 10, requestBackoff: 1 },
      async (_url, { signal } = {}) => {
        attempts += 1
        if (attempts === 1) {
          return new Promise((resolve, reject) => {
            const error = new Error('Request timed out')
            error.name = 'AbortError'
            if (signal?.aborted) {
              return reject(error)
            }
            signal?.addEventListener('abort', () => reject(error))
          })
        }
        return response({ data: [{ dt: 1, temp: 18 }] })
      },
    )
    assert.equal(attempts, 2)
    assert.equal(data.current.temp, 18)
  })

  it('uses canonical HTTPS endpoints for absolute and relative pagination links', async () => {
    for (const link of [
      'http://api.openweathermap.org/data/4.0/onecall/timeline/1h?start=21&cnt=20',
      '/data/4.0/onecall/timeline/1h/?start=21&cnt=20',
      '?start=21&cnt=20',
      'https://example.com/other-path?start=21&cnt=20&appid=other&lat=99&units=imperial&lang=en',
    ]) {
      const requests = []
      const data = await fetchOnecall({ ...config, exclude: 'current,minutely,daily' }, async (url) => {
        requests.push(url)
        assert.equal(url.origin, 'https://api.openweathermap.org')
        assert.equal(url.pathname, '/data/4.0/onecall/timeline/1h')
        assert.equal(url.searchParams.get('appid'), config.apikey)
        assert.equal(url.searchParams.get('lat'), '0')
        assert.equal(url.searchParams.get('units'), 'metric')
        assert.equal(url.searchParams.get('lang'), 'fr')
        if (requests.length === 1) {
          return response({ data: records(1, 20), next: link })
        }
        assert.equal(url.searchParams.get('start'), '21')
        assert.equal(url.searchParams.get('cnt'), '20')
        return response({ data: records(21, 20) })
      })
      assert.equal(requests.length, 2)
      assert.equal(data.hourly.length, 40)
      assert.equal(data.hourly[20].dt, 21)
    }
  })

  it('rejects pagination loops and missing or invalid cursors', async () => {
    const hourlyOnly = { ...config, exclude: 'current,minutely,daily' }
    let calls = 0
    await assert.rejects(fetchOnecall(hourlyOnly, async () => {
      calls += 1
      return response({ data: records(calls * 2, 2), next: '?start=2' })
    }), /Repeated One Call/)
    for (const next of ['https://example.com/page', '?start=invalid', '?start=']) {
      await assert.rejects(fetchOnecall(hourlyOnly, async () => response({ data: records(1, 2), next })), /Invalid One Call 4.0 pagination start/)
    }
    await assert.rejects(fetchOnecall(hourlyOnly, async url => response({ data: records(1, 2), next: `${url}&start=2` })), /pagination made no progress/)
  })
})
