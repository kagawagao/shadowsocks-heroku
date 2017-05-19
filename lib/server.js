const net = require('net')
const fs = require('fs')
const http = require('http')
const WebSocket = require('ws')
const parseArgs = require('minimist')
const { Encryptor } = require('./encrypt')

const { options, inetNtoa } = require('./utils')

const WebSocketServer = WebSocket.server

const configFromArgs = parseArgs(process.argv.slice(2), options)

const configFile = configFromArgs.config_file
const configContent = fs.readFileSync(configFile)
const config = JSON.parse(configContent)

if (process.env.PORT) {
  config['remote_port'] = +process.env.PORT
}

if (process.env.KEY) {
  config['password'] = process.env.KEY
}

if (process.env.METHOD) {
  config['method'] = process.env.METHOD
}

Object.assign(config, configFromArgs)

const timeout = Math.floor(config.timeout * 1000)

const LOCAL_ADDR = config['local_address']
const PORT = config['remote_port']
const KEY = config.password
const METHOD = config.method

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8'
  })

  res.end('<h1>Server Runninf</h1>')
})

const wss = new WebSocketServer({
  server
})

wss.on('connection', ws => {
  console.log('Server connected')
  console.log(`Soncurrent connections${wss.clients.length}`)

  const encryptor = new Encryptor(KEY, METHOD)
  let stage = 0
  let headerLength = 0
  let remote = null
  let cachedPieces = []
  let addrLen = 0
  let remoteAddr = null
  let remotePort = null
  ws.on('message', (data, flags) => {
    data = encryptor.decrypt(data)
    if (stage === 5) {
      if (!remote.write(data)) {
        ws._socket.pause()
      }
      return
    }
    if (stage === 0) {
      try {
        const addrType = data[0]
        if (addrType === 3) {
          addrLen = data[1]
        } else if (addrType !== 1) {
          console.warn(`Unsupported addrType: ${addrType}`)
          ws.close()
          return
        }
        if (addrType === 1) {
          remoteAddr = inetNtoa(data.slice(1, 5))
          remotePort = data.readUInt16BE(5)
          headerLength = 7
        } else {
          remoteAddr = data.slice(2, 2 + addrLen).toString('binary')
          remotePort = data.readUInt16BE(2 + addrLen)
          headerLength = 2 + addrLen + 2
        }

        remote = net.connect(remotePort, remoteAddr, () => {
          console.log('Connecting', remoteAddr)
          let i = 0
          while (i < cachedPieces.length) {
            const piece = cachedPieces[i]
            remote.write(piece)
            i++
          }
          cachedPieces = null
          stage = 5
        })

        remote.on('data', data => {
          data = encryptor.encrypt(data)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, {
              binary: true
            })

            if (ws.bufferedAmount > 0) {
              remote.pause()
            }
          }
        })

        remote.on('end', () => {
          ws.close()
          console.log('Remote disconnected')
        })

        remote.on('drain', () => {
          ws._socket.resume()
        })

        remote.on('error', (e) => {
          ws.terminate()
          console.log('Remote:', e)
        })

        remote.setTimeout(timeout, () => {
          console.loog('Remote timeout')
          remote.destroy()
          ws.close()
        })

        if (data.length > headerLength) {
          let buf = Buffer.alloc(data.length - headerLength)

          data.copy(buf, 0, headerLength)
          cachedPieces.push(buf)
          buf = null
        }
      } catch (e) {
        console.warn(e)
        if (remote) {
          remote.destroy()
        }
        ws.close()
      }
    }
  })

  ws.on('ping', () => {
    ws.pong('', null, true)
  })

  ws._socket.on('drain', () => {
    if (stage === 5) {
      remote.resume()
    }
  })

  ws.on('close', () => {
    console.log('Server disconnected')
    console.log('Concurrent connections', wss.clients.length)

    if (remote) {
      remote.destroy()
    }
  })

  ws.on('error', e => {
    console.warn('Server', e)
    console.log('Concurrent connections', wss.clients.length)
  })
})

server.listen(PORT, LOCAL_ADDR, () => {
  const address = server.address()
  console.log('Server listening at', address)
})

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log('address in use, aborting')
  }

  process.exit(1)
})
