const baseUrl = 'https://api.openweathermap.org/data/4.0/onecall/'

async function fetchOnecall(config, fetchImpl = fetch) {
  const version = config.apiVersion || '4.0'
  const createUrl = (endpoint) => {
    const url = new URL(endpoint)
    url.searchParams.set('lat', config.latitude)
    url.searchParams.set('lon', config.longitude)
    url.searchParams.set('appid', config.apikey)
    if (config.language) {
      url.searchParams.set('lang', config.language)
    }
    if (config.units) {
      url.searchParams.set('units', config.units === 'kelvin' ? 'standard' : config.units)
    }
    return url
  }
  const request = async (url) => {
    const response = await fetchImpl(url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    return response.json()
  }

  if (version !== '4.0') {
    const url = createUrl(`https://api.openweathermap.org/data/${version}/onecall`)
    url.searchParams.set('exclude', config.exclude || '')
    return request(url)
  }

  const excluded = new Set((config.exclude ?? 'minutely').split(',').map(value => value.trim()))
  const data = {}
  const alertIds = new Set()
  const endpoints = [
    ['current', 'current', 1],
    ['minutely', 'timeline/1min', 60],
    ['hourly', 'timeline/1h', 48],
    ['daily', 'timeline/1day', 8],
  ]

  await Promise.all(endpoints.map(async ([section, endpoint, limit]) => {
    if (excluded.has(section)) {
      return
    }
    let url = createUrl(`${baseUrl}${endpoint}`)
    const records = new Map()
    const visited = new Set()
    while (url && records.size < limit) {
      if (visited.has(url.href)) {
        throw new Error(`Repeated One Call 4.0 page for ${section}`)
      }
      visited.add(url.href)
      const page = await request(url)
      if (!Array.isArray(page.data) || (section === 'current' && !page.data.length)) {
        throw new Error(`Invalid One Call 4.0 response for ${section}`)
      }
      for (const key of ['lat', 'lon', 'timezone', 'timezone_offset']) {
        if (page[key] !== undefined) {
          data[key] = page[key]
        }
      }
      const previousSize = records.size
      for (const record of page.data) {
        if (records.size >= limit) {
          break
        }
        records.set(record.dt, record)
        for (const id of record.alerts || []) {
          alertIds.add(id)
        }
      }
      if (!page.next || records.size >= limit || !page.data.length) {
        break
      }
      if (records.size === previousSize) {
        throw new Error(`One Call 4.0 pagination made no progress for ${section}`)
      }
      const next = new URL(page.next, url)
      const start = next.searchParams.get('start')
      if (!start || !/^\d+$/.test(start)) {
        throw new Error(`Invalid One Call 4.0 pagination start for ${section}`)
      }
      // Use only the timeline cursor from API-generated links, which may use
      // another scheme or base path. Always request our canonical HTTPS endpoint.
      url = createUrl(`${baseUrl}${endpoint}`)
      url.searchParams.set('start', start)
      const count = next.searchParams.get('cnt')
      if (count && /^\d+$/.test(count) && Number(count) > 0) {
        url.searchParams.set('cnt', count)
      }
    }
    const values = [...records.values()].sort((left, right) => left.dt - right.dt)
    data[section] = section === 'current' ? values[0] : values
  }))

  if (!excluded.has('alerts') && config.showAlerts !== false) {
    const language = (config.language || 'en').toLowerCase().replaceAll('_', '-')
    const alerts = await Promise.all([...alertIds].map(async (id) => {
      const url = new URL(`${baseUrl}alert/${encodeURIComponent(id)}`)
      url.searchParams.set('appid', config.apikey)
      const alert = await request(url)
      if (Array.isArray(alert.description)) {
        const descriptions = alert.description
        const selected = descriptions.find(item => item.language.toLowerCase() === language)
          || descriptions.find(item => item.language.toLowerCase().split('-')[0] === language.split('-')[0])
          || descriptions.find(item => item.language.toLowerCase().startsWith('en'))
          || descriptions[0]
        alert.description = selected?.description || ''
      }
      // Some agencies provide tags but leave the event name empty.
      alert.event = alert.event || alert.tags?.join(', ') || 'Weather alert'
      return alert
    }))
    if (alerts.length) {
      data.alerts = alerts
    }
  }
  return data
}

module.exports = { fetchOnecall }
