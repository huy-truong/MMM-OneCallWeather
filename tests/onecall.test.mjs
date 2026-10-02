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

  it('rejects pagination loops and unexpected destinations', async () => {
    const hourlyOnly = { ...config, exclude: 'current,minutely,daily' }
    await assert.rejects(fetchOnecall(hourlyOnly, async url => response({ data: records(1, 2), next: url.href })), /Repeated One Call/)
    await assert.rejects(fetchOnecall(hourlyOnly, async () => response({ data: records(1, 2), next: 'https://example.com/page' })), /Invalid One Call 4.0 pagination URL/)
    await assert.rejects(fetchOnecall(hourlyOnly, async url => response({ data: records(1, 2), next: `${url}&start=2` })), /pagination made no progress/)
  })
})
