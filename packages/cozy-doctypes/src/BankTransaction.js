const keyBy = require('lodash/keyBy')
const groupBy = require('lodash/groupBy')
const max = require('lodash/max')
const Document = require('./Document')
const BankAccount = require('./BankAccount')
const log = require('./log')

const getDate = transaction => transaction.date.slice(0, 10)

/**
 * Get the date of the latest transaction in an array
 * @param {array} stackTransactions
 * @returns {string} The date of the latest transaction (YYYY-MM-DD)
 */
const getSplitDate = stackTransactions => {
  return max(stackTransactions.map(transaction => getDate(transaction)))
}

const ensureISOString = date => {
  if (date instanceof Date) {
    return date.toISOString()
  } else {
    return date
  }
}

class Transaction extends Document {
  static getDate(transaction) {
    return transaction
  }

  isAfter(minDate) {
    if (!minDate) {
      return true
    } else {
      const day = ensureISOString(this.date).slice(0, 10)
      if (day !== 'NaN') {
        return day > minDate
      } else {
        log(
          'warn',
          'transaction date could not be parsed. transaction: ' +
            JSON.stringify(this)
        )
        return false
      }
    }
  }

  isBeforeOrSame(maxDate) {
    if (!maxDate) {
      return true
    } else {
      const day = ensureISOString(this.date).slice(0, 10)
      if (day !== 'NaN') {
        return day <= maxDate
      } else {
        log(
          'warn',
          'transaction date could not be parsed. transaction: ' +
            JSON.stringify(this)
        )
        return false
      }
    }
  }

  /**
   * Get the descriptive (and almost uniq) identifier of a transaction
   * @param {object} transaction - The transaction (containing at least amount, originalBankLabel and date)
   * @returns {object}
   */
  getIdentifier() {
    return `${this.amount}-${this.originalBankLabel}-${this.date}`
  }

  /**
   * Get transactions that should be present in the stack but are not
   * The transactions are compared using Transaction.prototype.getIdentifier
   * @param {array} transactionsToCheck
   * @param {array} stackTransactions
   * @returns {array}
   */
  static getMissedTransactions(
    transactionsToCheck,
    stackTransactions,
    options = {}
  ) {
    const toCheckByIdentifier = groupBy(transactionsToCheck, t =>
      Transaction.prototype.getIdentifier.call(t)
    )

    const existingByIdentifier = groupBy(stackTransactions, t =>
      Transaction.prototype.getIdentifier.call(t)
    )

    const missedTransactions = []

    // Number of identifiers for which Linxo have more transactions than us
    let moreNewThanExisting = 0
    // Number of identifiers for which Linxo have less transactions than us
    let lessNewThanExisting = 0

    for (const [identifier, newTransactions] of Object.entries(
      toCheckByIdentifier
    )) {
      const existingTransactions = existingByIdentifier[identifier] || []

      if (newTransactions.length > existingTransactions.length) {
        const level =
          newTransactions.length === 1 && existingTransactions.length === 0
            ? 'debug'
            : 'warn'

        log(
          level,
          `Linxo have ${
            newTransactions.length
          } transactions, but we have only ${
            existingTransactions.length
          } with the same identifier as ${this.vendorIdAttr} ${
            newTransactions[0][this.vendorIdAttr]
          }`
        )

        moreNewThanExisting += 1

        const difference = newTransactions.length - existingTransactions.length
        missedTransactions.push(...newTransactions.slice(0, difference))
      }

      if (newTransactions.length < existingTransactions.length) {
        log(
          'warn',
          `Linxo have ${
            newTransactions.length
          } transactions, but we already have ${
            existingTransactions.length
          } with the same identifier as ${this.vendorIdAttr} ${
            existingTransactions[0][this.vendorIdAttr]
          }`
        )

        lessNewThanExisting += 1
      }
    }

    if (typeof options.onMissedTransactionsFound === 'function') {
      options.onMissedTransactionsFound(
        moreNewThanExisting,
        lessNewThanExisting
      )
    }

    return missedTransactions
  }

  static reconciliate(remoteTransactions, localTransactions, options = {}) {
    const findByVendorId = transaction =>
      localTransactions.find(t => t.vendorId === transaction.vendorId)

    const groups = groupBy(
      remoteTransactions,
      transaction =>
        findByVendorId(transaction) ? 'updatedTransactions' : 'newTransactions'
    )

    let newTransactions = groups.newTransactions || []
    const updatedTransactions = groups.updatedTransactions || []

    const splitDate = getSplitDate(localTransactions)

    if (splitDate) {
      if (options.onSplitDate) {
        options.onSplitDate()
      }

      const isAfterSplit = x => Transaction.prototype.isAfter.call(x, splitDate)
      const isBeforeSplit = x =>
        Transaction.prototype.isBeforeOrSame.call(x, splitDate)

      const transactionsAfterSplit = newTransactions.filter(isAfterSplit)

      if (transactionsAfterSplit.length > 0) {
        log(
          'info',
          `Found ${
            transactionsAfterSplit.length
          } transactions after ${splitDate}`
        )
      } else {
        log('info', `No transaction after ${splitDate}`)
      }

      const transactionsBeforeSplit = newTransactions.filter(isBeforeSplit)
      log(
        'info',
        `Found ${
          transactionsBeforeSplit.length
        } transactions before ${splitDate}`
      )

      const missedTransactions = Transaction.getMissedTransactions(
        transactionsBeforeSplit,
        localTransactions,
        options
      )

      if (missedTransactions.length > 0) {
        log(
          'info',
          `Found ${
            missedTransactions.length
          } missed transactions before ${splitDate}`
        )
      } else {
        log('info', `No missed transactions before ${splitDate}`)
      }

      newTransactions = [...transactionsAfterSplit, ...missedTransactions]
    } else {
      log('info', "Can't find a split date, saving all new transactions")
    }

    log(
      'info',
      `Transaction reconciliation: new ${newTransactions.length}, updated ${
        updatedTransactions.length
      }, split date ${splitDate} `
    )
    return [].concat(newTransactions).concat(updatedTransactions)
  }

  static async getMostRecentForAccounts(accountIds) {
    try {
      log('debug', 'Transaction.getLast')

      const index = await Document.getIndex(this.doctype, ['date', 'account'])
      const options = {
        selector: {
          date: { $gte: null },
          account: {
            $in: accountIds
          }
        },
        sort: [{ date: 'desc' }]
      }
      const transactions = await Document.query(index, options)
      log('info', 'last transactions length: ' + transactions.length)

      return transactions
    } catch (e) {
      log('error', e)

      return []
    }
  }

  static async deleteOrphans() {
    log('info', 'Deleting up orphan operations')
    const accounts = keyBy(await BankAccount.fetchAll(), '_id')
    const operations = await this.fetchAll()
    const orphanOperations = operations.filter(x => !accounts[x.account])
    log('info', `Total number of operations: ${operations.length}`)
    log('info', `Total number of orphan operations: ${orphanOperations.length}`)
    log('info', `Deleting ${orphanOperations.length} orphan operations...`)
    if (orphanOperations.length > 0) {
      return this.deleteAll(orphanOperations)
    }
  }

  getVendorAccountId() {
    return this[this.constructor.vendorAccountIdAttr]
  }
}
Transaction.doctype = 'io.cozy.bank.operations'
Transaction.version = 1
Transaction.vendorAccountIdAttr = 'vendorAccountId'
Transaction.vendorIdAttr = 'vendorId'
Transaction.idAttributes = ['vendorId']
Transaction.checkedAttributes = [
  'label',
  'originalBankLabel',
  'automaticCategoryId',
  'account'
]

module.exports = Transaction
