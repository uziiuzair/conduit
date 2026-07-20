// Read all of stdin and parse it as JSON. Hooks receive their event payload on
// stdin; on any error we resolve to {} so the caller can fail-open.
export async function readStdinJson() {
  return new Promise((resolve) => {
    let data = ""
    const timer = setTimeout(() => resolve(safeParse(data)), 2000)
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      data += chunk
    })
    process.stdin.on("end", () => {
      clearTimeout(timer)
      resolve(safeParse(data))
    })
    process.stdin.on("error", () => {
      clearTimeout(timer)
      resolve({})
    })
  })
}

function safeParse(s) {
  if (!s.trim()) return {}
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
