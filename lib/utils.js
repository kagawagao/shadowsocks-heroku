const path = require('path')

/**
 * inetNtoa
 * @method inetNtoa
 * @param  {Buffer} buf Buffer
 * @return {string}     Ip address
 */
const inetNtoa = buf => `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`

module.exports = {
  options: {
    alias: {
      'b': 'local_address',
      'r': 'remote_port',
      'k': 'password',
      'c': 'config_file',
      'm': 'method'
    },
    string: ['local_address', 'password', 'method', 'config_file'],
    default: {
      'config_file': path.resolve(process.cwd(), 'config.json')
    }
  },
  inetNtoa
}
