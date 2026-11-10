// J3 sentinel (qa-r7 P1): the 7789 port-conflict remediation must be USER-VISIBLE.
// The desktop capture door stamps every answer with `X-PickDone-Door: 1` and
// `X-PickDone-Port: <actualPort>`. This module classifies a probe against the door and
// returns the exact user-facing state + message (error text and retry guidance) the popup
// renders. Pure ESM, chrome-free, unit-tested in Node — no silent failure path exists.
export const DOOR_HEADER = 'x-pickdone-door'
export const PORT_HEADER = 'x-pickdone-port'

const portOf = endpoint => {
  try { return Number(new URL(endpoint).port) || 80 } catch { return 0 }
}

/**
 * @param {{endpoint: string, error?: Error, status?: number, headers?: object}} probe
 *   exactly one of error/status: a fetch rejection (door absent) or a completed HTTP answer.
 * @returns {{state: 'ok'|'unreachable'|'foreign'|'port-moved', message: string, bad: boolean}}
 */
export function classifyDoorProbe ({ endpoint, error, status, headers = {} } = {}) {
  const endpointPort = portOf(endpoint)
  if (error) {
    return {
      state: 'unreachable',
      bad: true,
      message: 'PickDone desktop is not reachable at ' + endpoint +
        '. Start PickDone and turn on Settings → Capture → endpoint, then press "Retry queued items now". ' +
        'Queued captures keep retrying automatically.'
    }
  }
  const door = String(headers[DOOR_HEADER] || '') === '1'
  if (!door) {
    return {
      state: 'foreign',
      bad: true,
      message: 'Port ' + endpointPort + ' on 127.0.0.1 is occupied by ANOTHER program (not PickDone), ' +
        'or an old PickDone build is answering. Free the port or open PickDone Settings → Capture to see the ' +
        'actual door address, fix the address field above, then retry.'
    }
  }
  const doorPort = Number(headers[PORT_HEADER])
  if (Number.isFinite(doorPort) && doorPort > 0 && doorPort !== endpointPort) {
    return {
      state: 'port-moved',
      bad: true,
      message: 'The PickDone capture door is answering on port ' + doorPort +
        ' (port ' + endpointPort + ' was busy at desktop start, so PickDone moved). ' +
        'Set the address above to http://127.0.0.1:' + doorPort + '/capture and retry.'
    }
  }
  return {
    state: 'ok',
    bad: false,
    message: 'Connected: the PickDone capture door at ' + endpoint + ' is live.'
  }
}

/**
 * Probe the door from an extension page (popup / options). Mirrors the desktop gates:
 * GET /tasks WITHOUT the key → the real door always answers 401 (with identity headers),
 * so the probe never needs the secret and never touches the db.
 * @param {(url:string)=>Promise<Response>} fetchImpl
 */
export async function probeDoor (endpoint, fetchImpl = (u => fetch(u))) {
  const probeUrl = endpoint.replace(/\/capture$/, '/tasks')
  try {
    const res = await fetchImpl(probeUrl)
    const headers = {}
    res.headers.forEach((v, k) => { headers[k] = v })
    return classifyDoorProbe({ endpoint, status: res.status, headers })
  } catch (e) {
    return classifyDoorProbe({ endpoint, error: e })
  }
}
