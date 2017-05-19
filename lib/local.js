const net = require('net')
const fs = require('fs')
const url = require('url')
const WebSocket = require('ws')
const parseArgs = require('minimist')
const { Encryptor } = require('../encrypt')

const { options, inetNtoa } = require('./utils')

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
const SCHEME = config.scheme
let SERVER = config.server
const REMOTE_PORT = config.remote_port
const LOCAL_ADDRESS = config.local_address
const PORT = config.local_port
const KEY = config.password
const METHOD = config.methodconst

const prepareServer = addr => {
  const serverUrl = url.parse(addr)
  serverUrl.slashes = true
  if (!serverUrl.protocol) {
    serverUrl.protocol = SCHEME
  }
  if (serverUrl.hostname === null) {
    serverUrl.hostname = addr
    serverUrl.pathname = '/'
  }
  if (serverUrl.port == null) {
    serverUrl.port = REMOTE_PORT
  }
  return url.format(serverUrl)
}

if (Array.isArray(SERVER)) {
  SERVER = SERVER.map(s => prepareServer(s))
} else {
  SERVER = prepareServer(SERVER)
}

const getServer = () => {
  if (Array.isArray(SERVER)) {
    return SERVER[Math.floor(Math.random() * SERVER.length)]
  } else {
    return SERVER
  }
}

const server = net.createServer(connection => {
  console.log('Local connected')
  server.getConnections((err, count) => {
    if (err) {
      console.warn(err)
    }
    console.log('Concurrent connections', count)
  })

  const encryptor = new Encryptor(KEY, METHOD)
  let stage = 0
  let headerLength = 0
  let cachedPieces = []
  let addrLen = 0
  let ws = null
  let ping = null
  let remoteAddr = null
  let remotePort = null
  let addrToSend = ''

  const aServer = getServer()

  connection.on('data', data => {
    if (stage === 5) {
      data = encryptor.encrypt(data)
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, {
          binary: true
        })

        if (ws.bufferedAmount > 0) {
          connection.pause()
        }
      }
      return
    }

    if (stage === 0) {
      const tempBuf = Buffer.alloc(2)
      tempBuf.write('\u0005\u0000', 0)
      connection.write(tempBuf)
      stage = 1
    }

    if (stage === 1) {
      try {
        const cmd = data[1]
        const addrType = data[3]
        if (cmd === 1) {
          console.log('Unsupported cmd:', cmd)
          const reply = Buffer.alloc('\u0005\u0007\u0000\u0001', 'binary')
          connection.end(reply)
          return
        }
        if (addrType === 3) {
          addrLen = data[4]
        } else if (addrType !== 1) {
          console.log('Unsupported addrType:', addrType)
          connection.end('Unsupported addrType')
          return
        }

        addrToSend = data.slice(3, 4).toString('binary')
        if (addrType === 1) {
          remoteAddr = inetNtoa(data.slice(4, 8))
          addrToSend += data.slice(4, 10).toString('binary')
          remotePort = data.readUInt16BE(8)
          headerLength = 10
        } else {
          remoteAddr = data.slice(5, 5 + addrLen).toString('binary')
          addrToSend += data.slice(4, 5 + addrLen + 2).toString('binary')
          remotePort = data.readUInt16BE(5 + addrLen)
          headerLength = 5 + addrLen + 2
        }
        const buf = Buffer.alloc(10)
        buf.write('\u0005\u0000\u0000\u0001', 0, 4, 'binary')
        buf.write('\u0000\u0000\u0000\u0000', 4, 4, 'binary')
        buf.writeInt16BE(remotePort, 8)
        connection.write(buf)
        ws = new WebSocket(aServer, {
          protocol: 'binary'
        })
        ws.on('open', function () {
          var addrToSendBuf, i, piece
          ws._socket.on('error', function (e) {
            console.log('remote ' + remoteAddr + ':' + remotePort + ' ' + e)
            connection.destroy()
            return server.getConnections((err, count) => {
              if (err) {
                throw err
              }
              console.log('concurrent connections:', count)
            })
          })
          console.log('connecting ' + remoteAddr + ' via ' + aServer)
          addrToSendBuf = Buffer.alloc(addrToSend, 'binary')
          addrToSendBuf = encryptor.encrypt(addrToSendBuf)
          ws.send(addrToSendBuf, {
            binary: true
          })
          i = 0
          while (i < cachedPieces.length) {
            piece = cachedPieces[i]
            piece = encryptor.encrypt(piece)
            ws.send(piece, {
              binary: true
            })
            i++
          }
          cachedPieces = null
          stage = 5
          ping = setInterval(function () {
            return ws.ping('', null, true)
          }, 50 * 1000)
          ws._socket.on('drain', function () {
            return connection.resume()
          })
        })
        ws.on('message', (data, flags) => {
          data = encryptor.decrypt(data)
          if (!connection.write(data)) {
            return ws._socket.pause()
          }
        })
        ws.on('close', () => {
          clearInterval(ping)
          console.log('remote disconnected')
          return connection.destroy()
        })
        ws.on('error', (e) => {
          console.log('remote ' + remoteAddr + ':' + remotePort + ' error: ' + e)
          connection.destroy()
          return server.getConnections((err, count) => {
            if (err) {
              throw err
            }
            console.log('concurrent connections:', count)
          })
        })
        if (data.length > headerLength) {
          let buf = Buffer.alloc(data.length - headerLength)
          data.copy(buf, 0, headerLength)
          cachedPieces.push(buf)
          buf = null
        }
        stage = 4
      } catch (e) {
        console.log(e)
        connection.destroy()
      }
    } else {
      if (stage === 4) {
        cachedPieces.push(data)
      }
    }
  })
  connection.on('end', () => {
    console.log('local disconnected')
    if (ws) {
      ws.terminate()
    }
    return server.getConnections((err, count) => {
      if (err) {
        console.log(err)
      }
      console.log('concurrent connections:', count)
    })
  })
  connection.on('error', function (e) {
    console.log('local error: ' + e)
    if (ws) {
      ws.terminate()
    }
    return server.getConnections((err, count) => {
      if (err) {
        console.log(err)
      }
      console.log('concurrent connections:', count)
    })
  })
  connection.on('drain', function () {
    if (ws && ws._socket) {
      return ws._socket.resume()
    }
  })
  connection.setTimeout(timeout, () => {
    console.log('local timeout')
    connection.destroy()
    if (ws) {
      ws.terminate()
    }
  })
})

server.listen(PORT, LOCAL_ADDRESS, () => {
  return console.log('server listening at', LOCAL_ADDRESS, ':', PORT)
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('address in use, aborting')
  }
  process.exit(1)
})
