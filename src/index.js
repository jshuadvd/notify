import bigInt from "big-integer"
import uuid from "uuid/v4"
import blocknativeApi from "./bn-api-client"
import Notify from "./views/Notify.svelte"

import { app, transactions } from "./stores"
import {
  handlePreFlightEvent,
  handleTransactionEvent,
  duplicateTransactionCandidate
} from "./transactions"

const version = "0.0.1"

let transactionQueue
transactions.subscribe(store => (transactionQueue = store))

function init(config) {
  // validate config
  const { dappId, networkId } = config

  const blocknative = blocknativeApi({
    dappId,
    networkId,
    transactionCallback: handleTransactionEvent
  })

  // save config to app store
  app.update(store => ({ ...store, ...config, version }))

  // initialize App
  new Notify({
    target: document.body
  })

  return {
    account,
    hash,
    transaction
  }

  function account(address) {
    const { emitter } = blocknative.account(address)
    return emitter
  }

  function hash(hash, id) {
    const { emitter } = blocknative.transaction(hash, id)
    return emitter
  }

  function transaction(options) {
    return new Promise(async (resolve, reject) => {
      // @TODO - validate options
      // validateTransactionOptions(options)

      const {
        sendTransaction,
        estimateGas,
        gasPrice,
        balance,
        contract,
        txDetails,
        listeners
      } = options

      //=== if `balance` is not provided, then sufficient funds check is disabled === //
      //=== if `txDetails` is not provided, then duplicate transaction check is disabled === //
      //== if dev doesn't want notifiy to intiate the transaction and `sendTransaction` is not provided, then transaction rejected notification is disabled ==//
      //=== to disable hints for `txAwaitingApproval`, `txConfirmReminder` or any other notification, then return false from listener functions ==//

      const gasLimit =
        estimateGas &&
        bigInt(
          await estimateGas().catch(err =>
            console.error("There was a problem estimating gas:", err)
          )
        )
      const price =
        gasPrice &&
        bigInt(
          await gasPrice().catch(err =>
            console.error("There was a problem getting current gas price:", err)
          )
        )

      const id = uuid()

      const txObject = {
        ...txDetails,
        gas: gasLimit && gasLimit.toString(),
        gasPrice: price && price.toString(),
        id
      }

      // check sufficient balance if required parameters are available
      if (balance && gasLimit && gasPrice) {
        const transactionCost = gasLimit
          .times(price)
          .plus(bigInt(txDetails.value))

        // if transaction cost is greater than the current balance
        if (transactionCost.compare(bigInt(balance)) === 1) {
          const eventCode = "nsfFail"

          handlePreFlightEvent({
            blocknative,
            eventCode,
            contract,
            balance,
            txObject,
            listeners
          })

          return reject("User has insufficient funds")
        }
      }

      // check if it is a duplicate transaction
      if (
        txDetails &&
        duplicateTransactionCandidate(
          { to: txDetails.to, value: txDetails.value },
          contract
        )
      ) {
        const eventCode = "txRepeat"

        handlePreFlightEvent({
          blocknative,
          eventCode,
          contract,
          balance,
          txObject,
          listeners
        })
      }

      // check previous transactions awaiting approval
      if (transactionQueue.find(tx => tx.status === "awaitingApproval")) {
        const eventCode = "txAwaitingApproval"

        handlePreFlightEvent({
          blocknative,
          eventCode,
          contract,
          balance,
          txObject,
          listeners
        })
      }

      // confirm reminder after timeout
      setTimeout(() => {
        const awaitingApproval = transactionQueue.find(
          tx => tx.id === id && tx.status === "awaitingApproval"
        )

        if (awaitingApproval) {
          const eventCode = "txConfirmReminder"

          handlePreFlightEvent({
            blocknative,
            eventCode,
            contract,
            balance,
            txObject,
            listeners
          })
        }
      }, 20000)

      handlePreFlightEvent({
        blocknative,
        eventCode: "txRequest",
        status: "awaitingApproval",
        contract,
        balance,
        txObject,
        listeners
      })

      // if not provided with sendTransaction function, resolve with id so dev can initiate transaction
      // dev will need to call notify.hash(txHash, id) with this id to link up the preflight with the postflight notifications
      if (!sendTransaction) {
        return resolve({ id })
      }

      // initiate transaction
      const sendTransactionResult = sendTransaction()

      // get result and handle rejection
      const result = await sendTransactionResult.catch(err => {
        const eventCode = "txSendFail"

        handlePreFlightEvent({
          blocknative,
          eventCode,
          status: "failed",
          contract,
          balance,
          txObject,
          listeners
        })

        // @TODO - need to properly handle possible errors here
        return reject("User rejected transaction")
      })

      if (result && result.hash) {
        // call blocknative.transaction with hash
        const { emitter } = hash(result.hash, id)

        // Check for pending stall status
        setTimeout(() => {
          const transaction = transactionQueue.find(tx => tx.id === id)
          if (
            transaction &&
            transaction.status === "sent" &&
            blocknative.status.connected &&
            blocknative.status.nodeSynced
          ) {
            const eventCode = "txStallPending"

            handlePreFlightEvent({
              blocknative,
              eventCode,
              contract,
              balance,
              txObject,
              listeners
            })
          }
        }, 20000) // @TODO - Need to work out how to have this configurable

        // Check for confirmed stall status
        setTimeout(() => {
          const transaction = transactionQueue.find(tx => tx.id === id)

          if (
            transaction &&
            transaction.status === "pending" &&
            blocknative.status.connected &&
            blocknative.status.nodeSynced
          ) {
            const eventCode = "txStallConfirmed"

            handlePreFlightEvent({
              blocknative,
              eventCode,
              contract,
              balance,
              txObject,
              listeners
            })
          }
        }, 30000) // @TODO - Need to work out how to have this configurable

        resolve({ emitter, sendTransactionResult })
      }
    })
  }

  // function custom(notification) {
  //   return {
  //     dismiss,
  //     update
  //   }
  // }

  // function style(config) {
  //   styles.update(store => ({ ...store, ...config }))
  // }
}

export default { init }
