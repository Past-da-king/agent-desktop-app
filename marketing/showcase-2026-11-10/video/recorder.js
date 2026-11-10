// Runs in the WhatsApp Web page of the phone's agent browser, BEFORE the call is placed (after the bridge is armed is fine too).
// Records the two sides of the call as two Opus files, so the video can carry the real voices:
//   voice = what the agent says (the bridge's made-up microphone), them = what the call plays to the speaker.
// It only listens: it adds one more listener next to the bridge's own tap and changes nothing the call uses.
// Read back with window.__rec.finish() then window.__rec.slice(name, i) (base64 pieces).
(() => {
  const H = window.__hina
  if (!H || !H.ensureMic) return 'no call bridge on this page'
  if (window.__rec) return 'recorder already on'
  const R = (window.__rec = { started: {}, firstData: {}, parts: {}, mrs: {}, errs: [], b64: {} })
  const rec = (name, stream) => {
    const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 96000 })
    R.parts[name] = []
    mr.ondataavailable = (e) => { if (e.data && e.data.size) { if (!R.firstData[name]) R.firstData[name] = Date.now(); R.parts[name].push(e.data) } }
    mr.start(500); R.started[name] = Date.now(); R.mrs[name] = mr
  }
  try { rec('voice', H.ensureMic()) } catch (e) { R.errs.push('voice: ' + e.message) }
  const prev = AudioNode.prototype.connect
  AudioNode.prototype.connect = function (dest, ...r) {
    try {
      const ctx = this.context
      if (!ctx.__hinaOwn && dest instanceof AudioDestinationNode) {
        if (!ctx.__recDest) { ctx.__recDest = ctx.createMediaStreamDestination(); rec('them', ctx.__recDest.stream) }
        H.origConnect.call(this, ctx.__recDest)
      }
    } catch (e) { R.errs.push('them: ' + e.message) }
    return prev.call(this, dest, ...r)
  }
  R.finish = async () => {
    for (const [name, mr] of Object.entries(R.mrs)) {
      if (mr.state !== 'inactive') await new Promise((res) => { mr.onstop = res; mr.stop() })
      const buf = new Uint8Array(await new Blob(R.parts[name], { type: 'audio/webm' }).arrayBuffer())
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
      R.b64[name] = btoa(s)
    }
    return { started: R.started, firstData: R.firstData, errs: R.errs, sizes: Object.fromEntries(Object.entries(R.b64).map(([k, v]) => [k, v.length])) }
  }
  R.slice = (name, i, n = 48000) => (R.b64[name] || '').slice(i * n, (i + 1) * n)
  return 'recorder on'
})()
