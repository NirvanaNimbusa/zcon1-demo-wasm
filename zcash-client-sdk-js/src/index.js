import { Client } from 'zcash-client-backend-wasm'

const { BlockID, BlockRange, ChainSpec, RawTransaction } = require('./service_pb.js')
const { CompactTxStreamerClient } = require('./service_grpc_web_pb.js')
const grpc = {}
grpc.web = require('grpc-web')

const COIN = 100000000

const SAPLING_CONSENSUS_BRANCH_ID = 0x76b809bb

const CHAIN_REFRESH_INTERVAL = 60 * 1000
const BATCH_SIZE = 1000

export class ZcashClient {
  constructor (lightwalletdURL, uiHandlers, checkpoint) {
    this.lightwalletd = new CompactTxStreamerClient(lightwalletdURL)
    this.client = Client.new()
    this.uiHandlers = uiHandlers

    if (!this.client.set_initial_block(checkpoint.height, checkpoint.hash, checkpoint.sapling_tree)) {
      console.error('Invalid checkpoint data')
    }
  }

  fetchSpendParams () {
    var self = this

    var req = new XMLHttpRequest()
    req.addEventListener('load', function () {
      var buffer = req.response
      if (buffer) {
        self.spendParams = new Uint8Array(buffer)
      } else {
        console.error("Didn't receive sapling-spend.params")
      }
    })
    req.open('GET', 'params/sapling-spend.params')
    req.responseType = 'arraybuffer'
    req.send()
  }

  fetchOutputParams () {
    var self = this

    var req = new XMLHttpRequest()
    req.addEventListener('load', function () {
      var buffer = req.response
      if (buffer) {
        self.outputParams = new Uint8Array(buffer)
      } else {
        console.error("Didn't receive sapling-spend.params")
      }
    })
    req.open('GET', 'params/sapling-output.params')
    req.responseType = 'arraybuffer'
    req.send()
  }

  updateUI () {
    this.uiHandlers.updateBalance(this.client.balance() / COIN, this.client.verified_balance() / COIN)
  }

  sync () {
    var self = this

    var chainSpec = new ChainSpec()

    self.lightwalletd.getLatestBlock(chainSpec, {}, (err, latestBlock) => {
      if (err) {
        console.error('Error fetching latest block')
        console.error(`Error code: ${err.code} "${err.message}"`)
        return
      }

      var startHeight = self.client.last_scanned_height()
      var latestHeight = latestBlock.getHeight()
      if (startHeight === latestHeight) {
        console.log('No new blocks')
        window.setTimeout(() => { self.sync() }, CHAIN_REFRESH_INTERVAL)
        return
      }

      var endHeight
      if (latestHeight - startHeight < BATCH_SIZE) {
        endHeight = latestHeight
      } else {
        endHeight = startHeight + BATCH_SIZE - 1
      }
      console.debug(`Latest block: ${latestHeight}`)
      console.debug(`Requesting blocks in range [${startHeight}, ${endHeight}]`)

      var blockStart = new BlockID()
      blockStart.setHeight(startHeight)
      var blockEnd = new BlockID()
      blockEnd.setHeight(endHeight)
      var blockRange = new BlockRange()
      blockRange.setStart(blockStart)
      blockRange.setEnd(blockEnd)

      var stream = self.lightwalletd.getBlockRange(blockRange, {})
      stream.on('data', (block) => {
        // Scan the block
        if (!self.client.scan_block(block.serializeBinary())) {
          console.error('Failed to scan block')
        }
      })
      stream.on('status', (status) => {
        if (status.metadata) {
          console.debug('Received metadata')
          console.debug(status.metadata)
        }
        if (status.code !== grpc.web.StatusCode.OK) {
          console.error(`Error code: ${status.code} "${status.details}"`)
        }

        // Perform end-of-stream updates here, because we don't always get the
        // 'end' event for some reason, but we do always get the 'status' event.

        var syncedHeight = self.client.last_scanned_height()
        if (endHeight !== syncedHeight) {
          console.error('Block stream finished before expected end height')
        }

        // Update UI for current chain status
        console.log(`Scanned to height: ${syncedHeight}`)
        self.updateUI()
        self.uiHandlers.updateSyncStatus(syncedHeight, latestHeight)

        // Queue up the next sync
        if (syncedHeight === latestHeight) {
          console.log('Finished syncing!')
          window.setTimeout(() => { self.sync() }, CHAIN_REFRESH_INTERVAL)
        } else {
          self.sync()
        }
      })
      stream.on('error', (err) => {
        console.error('Error while streaming blocks')
        console.error(`Error code: ${err.code} "${err.message}"`)
      })
      stream.on('end', () => {
        console.debug('Block stream end signal received')
      })
    })
  }

  sendToAddress (to, value, onFinished) {
    var self = this

    console.log(`Sending ${value} TAZ to ${to}`)

    var tx = self.client.send_to_address(
      SAPLING_CONSENSUS_BRANCH_ID,
      self.spendParams,
      self.outputParams,
      to,
      value * COIN)
    if (tx == null) {
      console.error('Failed to create transaction')
      onFinished()
      return
    }

    var rawTx = new RawTransaction()
    rawTx.setData(tx)

    console.log('Sending transaction...')
    self.lightwalletd.sendTransaction(rawTx, {}, (response) => {
      console.log('Sent transaction')
      if (response != null) {
        console.log(`Error code: ${response.getErrorcode()} "${response.getErrormessage()}"`)
      }

      self.updateUI()

      onFinished()
    })
  }

  load (onFinished) {
    var self = this

    var loader = () => {
      // Fetch Sapling parameters
      self.fetchSpendParams()
      self.fetchOutputParams()

      // Register event handlers

      // Initial UI updates
      self.uiHandlers.setAddress(self.client.address())
      self.updateUI()

      // Finished loading!
      onFinished()
    }

    // document.addEventListener('DOMContentLoaded', loader, false)
    loader()
  }
}
