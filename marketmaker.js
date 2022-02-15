import WebSocket from 'ws';
import * as zksync from "zksync";
import ethers from 'ethers';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs';

dotenv.config();

// Globals
const PRICE_FEEDS = {};
const OPEN_ORDERS = {};
const NONCES = {};
const WALLETS = {};
const FILL_QUEUE = [];
const MARKETS = {};
const CHAINLINK_PROVIDERS = {};
const PAST_ORDER_LIST = {};


// Load MM config
let MM_CONFIG;
if (process.env.MM_CONFIG) {
    MM_CONFIG = JSON.parse(process.env.MM_CONFIG);
}
else {
    const mmConfigFile = fs.readFileSync("config.json", "utf8");
    MM_CONFIG = JSON.parse(mmConfigFile);
}
let activePairs = [];
for (let marketId in MM_CONFIG.pairs) {
    const pair = MM_CONFIG.pairs[marketId];
    if (pair.active) {
        activePairs.push(marketId);
    }
}
console.log("ACTIVE PAIRS", activePairs);

// Connect to zksync
const CHAIN_ID = parseInt(MM_CONFIG.zigzagChainId);
const ETH_NETWORK = (CHAIN_ID === 1) ? "mainnet" : "rinkeby";
let ethersProvider;
const providerUrl = (process.env.INFURA_URL || MM_CONFIG.infuraUrl);
if(providerUrl && ETH_NETWORK=="mainnet") {
    ethersProvider = ethers.getDefaultProvider(providerUrl);
} else {
    ethersProvider = ethers.getDefaultProvider(ETH_NETWORK);
}

// Start price feeds
await setupPriceFeeds();

let syncProvider;
try {
    syncProvider = await zksync.getDefaultProvider(ETH_NETWORK);
    const keys = [];
    const ethPrivKey = (process.env.ETH_PRIVKEY || MM_CONFIG.ethPrivKey);
    if(ethPrivKey && ethPrivKey != "") { keys.push(ethPrivKey);  }
    let ethPrivKeys;
    if (process.env.ETH_PRIVKEYS) {
        ethPrivKeys = JSON.parse(process.env.ETH_PRIVKEYS);
    }
    else {
        ethPrivKeys = MM_CONFIG.ethPrivKeys;
    }
    if(ethPrivKeys && ethPrivKeys.length > 0) {
        ethPrivKeys.forEach( key => {
            if(key != "" && !keys.includes(key)) {
                keys.push(key);
            }
        });
    }
    for(let i=0; i<keys.length; i++) {
        let ethWallet = new ethers.Wallet(keys[i]);
        let syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
        if (!(await syncWallet.isSigningKeySet())) {
            console.log("setting sign key");
            const signKeyResult = await syncWallet.setSigningKey({
                feeToken: "ETH",
                ethAuthType: "ECDSA",
            });
            console.log(signKeyResult);
        }
        let accountId = await syncWallet.getAccountId();
        let account_state = await syncWallet.getAccountState();
        WALLETS[accountId] = {
            'ethWallet': ethWallet,
            'syncWallet': syncWallet,
            'account_state': account_state,
            'ORDER_BROADCASTING': false,
        }
    }
} catch (e) {
    console.log(e);
    throw new Error("Could not connect to zksync API");
}

// Update account state loop
setInterval(updateAccountState, 30000);

// Log mm balance over all accounts
logBalance();
setInterval(logBalance, 3 * 60 * 60 * 1000); // 3h

// Initiate fill loop
setTimeout(processFillQueue, 1000);

let fillOrdersInterval, indicateLiquidityInterval;
let zigzagws = new WebSocket(MM_CONFIG.zigzagWsUrl);
zigzagws.on('open', onWsOpen);
zigzagws.on('close', onWsClose);
zigzagws.on('error', console.error);

function onWsOpen() {
    zigzagws.on('message', handleMessage);
    fillOrdersInterval = setInterval(fillOpenOrders, 5000);
    indicateLiquidityInterval = setInterval(indicateLiquidity, 5000);
    for (let market in MM_CONFIG.pairs) {
        if (MM_CONFIG.pairs[market].active) {
            const msg = {op:"subscribemarket", args:[CHAIN_ID, market]};
            zigzagws.send(JSON.stringify(msg));
        }
    }
}

function onWsClose () {
    console.log("Websocket closed. Restarting");
    Object.keys(WALLETS).forEach(accountId => {
        WALLETS[accountId]['ORDER_BROADCASTING'] = false;
    });
    setTimeout(() => {
        clearInterval(fillOrdersInterval)
        clearInterval(indicateLiquidityInterval)
        zigzagws = new WebSocket(MM_CONFIG.zigzagWsUrl);
        zigzagws.on('open', onWsOpen);
        zigzagws.on('close', onWsClose);
        zigzagws.on('error', console.error);
    }, 5000);
}

async function handleMessage(json) {
    const msg = JSON.parse(json);
    if (!(["lastprice", "liquidity2", "fillstatus", "marketinfo"]).includes(msg.op)) console.log(json.toString());
    switch(msg.op) {
        case 'error':
            Object.keys(WALLETS).forEach(accountId => {
                WALLETS[accountId]['ORDER_BROADCASTING'] = false;
            });
            break;
        case 'orders':
            const orders = msg.args[0];
            orders.forEach(order => {
                const orderId = order[1];
                const fillable = isOrderFillable(order);
                console.log(fillable);
                if (fillable.fillable) {
                    FILL_QUEUE.push({ order: order, wallets: fillable.wallets});
                }
                else if (fillable.reason === "badprice") {
                    OPEN_ORDERS[orderId] = order;
                }
            });
            break
        case "userordermatch":
            const chainId = msg.args[0];
            const orderId = msg.args[1];
            const fillOrder = msg.args[3];
            const wallet = WALLETS[fillOrder.accountId];
            if(!wallet) {
                console.error("No wallet with this accountId: "+fillOrder.accountId);
                break
            } else {
                try {
                    await broadcastfill(chainId, orderId, msg.args[2], fillOrder, wallet);
                } catch (e) {
                    console.error(e);
                }
                wallet['ORDER_BROADCASTING'] = false;
            }
            break
        case "marketinfo":
            const marketInfo = msg.args[0];
            const marketId  = marketInfo.alias;
            if(!marketId) break
            let oldBaseFee = "N/A", oldQuoteFee = "N/A";
            try {
                oldBaseFee = MARKETS[marketId].baseFee;
                oldQuoteFee = MARKETS[marketId].quoteFee;
            } catch (e) {
                // pass, no old marketInfo
            }
            MARKETS[marketId] = marketInfo;
            const newBaseFee = MARKETS[marketId].baseFee;
            const newQuoteFee = MARKETS[marketId].quoteFee;
            console.log(`marketinfo ${} - update baseFee ${oldBaseFee} -> ${newBaseFee}, quoteFee ${oldQuoteFee} -> ${newQuoteFee}`);
            break
        default:
            break
    }
}

function isOrderFillable(order) {
    const chainId = order[0];
    const marketId = order[2];
    const market = MARKETS[marketId];
    const mmConfig = MM_CONFIG.pairs[marketId];
    const mmSide = mmConfig.side || 'd';
    if (chainId != CHAIN_ID) return { fillable: false, reason: "badchain" }
    if (!market) return { fillable: false, reason: "badmarket" }
    if (!mmConfig.active) return { fillable: false, reason: "inactivemarket" }

    const baseQuantity = order[5];
    const quoteQuantity = order[6];
    const expires = order[7];
    const side = order[3];
    const price = order[4];
    const sellCurrency = (side === 's') ? market.quoteAsset.symbol : market.baseAsset.symbol;
    const sellDecimals = (side === 's') ? market.quoteAsset.decimals : market.baseAsset.decimals;
    const sellQuantity = (side === 's') ? quoteQuantity : baseQuantity;
    const neededBalanceBN = sellQuantity * 10**sellDecimals;
    const goodWallets = [];
    Object.keys(WALLETS).forEach(accountId => {
        const walletBalance = WALLETS[accountId]['account_state'].committed.balances[sellCurrency];
        if (Number(walletBalance) > (neededBalanceBN * 1.05)) {
            goodWallets.push(accountId);
        }
    });
    const now = Date.now() / 1000 | 0;

    if (now > expires) {
        return { fillable: false, reason: "expired" };
    }

    if (mmSide !== 'd' && mmSide == side) {
        return { fillable: false, reason: "badside" };
    }

    if (baseQuantity < mmConfig.minSize) {
        return { fillable: false, reason: "badsize" };
    }
    else if (baseQuantity > mmConfig.maxSize) {
        return { fillable: false, reason: "badsize" };
    }

    if (goodWallets.length === 0) {
        return { fillable: false, reason: "badbalance" };
    }

    let quote;
    try {
        quote = genQuote(chainId, marketId, side, baseQuantity);
    } catch (e) {
        return { fillable: false, reason: e.message }
    }

    if (side == 's' && price > quote.quotePrice) {
        return { fillable: false, reason: "badprice" };
    }
    else if (side == 'b' && price < quote.quotePrice) {
        return { fillable: false, reason: "badprice" };
    }

    return { fillable: true, reason: null, wallets: goodWallets};
}

function genQuote(chainId, marketId, side, baseQuantity) {
    const market = MARKETS[marketId];
    if (CHAIN_ID !== chainId) throw new Error("badchain");
    if (!market) throw new Error("badmarket");
    if (!(['b','s']).includes(side)) throw new Error("badside");
    if (baseQuantity <= 0) throw new Error("badquantity");

    validatePriceFeed(marketId);

    const mmConfig = MM_CONFIG.pairs[marketId];
    const mmSide = mmConfig.side || 'd';
    if (mmConfig.side !== 'd' && mmConfig.side === side) {
        throw new Error("badside");
    }
    const primaryPrice = getMidPrice(marketId);
    if (!primaryPrice) throw new Error("badprice");
    const SPREAD = mmConfig.minSpread + (baseQuantity * mmConfig.slippageRate);
    let quoteQuantity;
    if (side === 'b') {
        quoteQuantity = (baseQuantity * primaryPrice * (1 + SPREAD)) + market.quoteFee;
    }
    else if (side === 's') {
        quoteQuantity = (baseQuantity - market.baseFee) * primaryPrice * (1 - SPREAD);
    }
    const quotePrice = (quoteQuantity / baseQuantity).toPrecision(6);
    if (quotePrice < 0) throw new Error("Amount is inadequate to pay fee");
    if (isNaN(quotePrice)) throw new Error("Internal Error. No price generated.");
    return { quotePrice, quoteQuantity };
}

function validatePriceFeed(marketId) {
    const mmConfig = MM_CONFIG.pairs[marketId];
    const mode = MM_CONFIG.pairs[marketId].mode || "pricefeed";
    const initPrice = MM_CONFIG.pairs[marketId].initPrice;
    const primaryPriceFeedId = MM_CONFIG.pairs[marketId].priceFeedPrimary;
    const secondaryPriceFeedId = MM_CONFIG.pairs[marketId].priceFeedSecondary;

    // Constant mode checks
    if (mode === "constant") {
        if (initPrice) return true;
        else throw new Error("No initPrice available");
    }

    // Check if primary price exists
    const primaryPrice = PRICE_FEEDS[primaryPriceFeedId];
    if (!primaryPrice) throw new Error("Primary price feed unavailable");


    // If there is no secondary price feed, the price auto-validates
    if (!secondaryPriceFeedId) return true;

    // Check if secondary price exists
    const secondaryPrice = PRICE_FEEDS[secondaryPriceFeedId];
    if (!secondaryPrice) throw new Error("Secondary price feed unavailable");

    // If the secondary price feed varies from the primary price feed by more than 1%, assume something is broken
    const percentDiff = Math.abs(primaryPrice - secondaryPrice) / primaryPrice;
    if (percentDiff > 0.03) {
        throw new Error("Circuit breaker triggered");
    }

    return true;
}

async function sendFillRequest(orderreceipt, accountId) {
    const chainId = orderreceipt[0];
    const orderId = orderreceipt[1];
    const marketId = orderreceipt[2];
    const market = MARKETS[marketId];
    const baseCurrency = market.baseAssetId;
    const quoteCurrency = market.quoteAssetId;
    const side = orderreceipt[3];
    const baseQuantity = orderreceipt[5];
    const quoteQuantity = orderreceipt[6];
    const quote = genQuote(chainId, marketId, side, baseQuantity);
    let tokenSell, tokenBuy, sellQuantity, buyQuantity;
    if (side === "b") {
        tokenSell = market.baseAssetId;
        tokenBuy = market.quoteAssetId;
        // Add 1 bip to to protect against rounding errors
        sellQuantity = (baseQuantity * 1.0001).toFixed(market.baseAsset.decimals);
        buyQuantity = (quote.quoteQuantity * 0.9999).toFixed(market.quoteAsset.decimals);
    } else if (side === "s") {
        tokenSell = market.quoteAssetId;
        tokenBuy = market.baseAssetId;
        // Add 1 bip to to protect against rounding errors
        sellQuantity = (quote.quoteQuantity * 1.0001).toFixed(market.quoteAsset.decimals);
        buyQuantity = (baseQuantity * 0.9999).toFixed(market.baseAsset.decimals);
    }
    const sellQuantityParsed = syncProvider.tokenSet.parseToken(
        tokenSell,
        sellQuantity
    );
    const sellQuantityPacked = zksync.utils.closestPackableTransactionAmount(sellQuantityParsed);
    const tokenRatio = {};
    tokenRatio[tokenBuy] = buyQuantity;
    tokenRatio[tokenSell] = sellQuantity;
    const oneMinExpiry = (Date.now() / 1000 | 0) + 60;
    const orderDetails = {
        tokenSell,
        tokenBuy,
        amount: sellQuantityPacked,
        ratio: zksync.utils.tokenRatio(tokenRatio),
        validUntil: oneMinExpiry
    }
    const fillOrder = await WALLETS[accountId].syncWallet.getOrder(orderDetails);

    // Set wallet flag
    WALLETS[accountId]['ORDER_BROADCASTING'] = true;

    rememberOrder(chainId, orderId, marketId, quote.quotePrice, fillOrder);
    const resp = { op: "fillrequest", args: [chainId, orderId, fillOrder] };
    zigzagws.send(JSON.stringify(resp));
}

async function broadcastfill(chainId, orderId, swapOffer, fillOrder, wallet) {
    // Nonce check
    const nonce = swapOffer.nonce;
    const userNonce = NONCES[swapOffer.accountId];
    if (nonce <= userNonce) {
        throw new Error("badnonce");
    }
    const randInt = (Math.random()*1000).toFixed(0);
    console.time('syncswap' + randInt);
    const swap = await wallet['syncWallet'].syncSwap({
        orders: [swapOffer, fillOrder],
        feeToken: "ETH",
        nonce: fillOrder.nonce
    });
    const txHash = swap.txHash.split(":")[1];
    const txHashMsg = {op:"orderstatusupdate", args:[[[chainId,orderId,'b',txHash]]]}
    zigzagws.send(JSON.stringify(txHashMsg));
    console.timeEnd('syncswap' + randInt);

    console.time('receipt' + randInt);
    let receipt, success = false;
    try {
        receipt = await swap.awaitReceipt();
        if (receipt.success) {
            success = true;
            NONCES[swapOffer.accountId] = swapOffer.nonce;
        }
    } catch (e) {
        receipt = null;
        success = false;
    }
    console.timeEnd('receipt' + randInt);
    console.log("Swap broadcast result", {swap, receipt});

    if(success) {
        const order = PAST_ORDER_LIST[orderId];
        if(order) {
            const marketId = order.market;
            const mmConfig = MM_CONFIG.pairs[marketId];
            if(mmConfig && mmConfig.delayAfterFill) {
                mmConfig.active = false;
                setTimeout(activatePair, mmConfig.delayAfterFill * 1000, market_id);
                console.log(`Set ${market_id} passive for ${mmConfig.delayAfterFill} seconds.`)
            }
        }
   }

    const newStatus = success ? 'f' : 'r';
    const error = success ? null : swap.error.toString();
    const orderCommitMsg = {op:"orderstatusupdate", args:[[[chainId,orderId,newStatus,txHash,error]]]}
    zigzagws.send(JSON.stringify(orderCommitMsg));
}

async function fillOpenOrders() {
    for (let orderId in OPEN_ORDERS) {
        const order = OPEN_ORDERS[orderId];
        const fillable = isOrderFillable(order);
        if (fillable.fillable) {
            FILL_QUEUE.push({ order: order, wallets: fillable.wallets});
            delete OPEN_ORDERS[orderId];
        }
        else if (fillable.reason !== "badprice") {
            delete OPEN_ORDERS[orderId];
        }
    }
}

async function processFillQueue() {
    if (FILL_QUEUE.length === 0) {
        setTimeout(processFillQueue, 100);
        return;
    }
    await Promise.all(Object.keys(WALLETS).map(async accountId => {
        const wallet = WALLETS[accountId];
        if (wallet['ORDER_BROADCASTING']) {
            return;
        }
        let index = 0;
        for(;index<FILL_QUEUE.length; index++) {
            if(FILL_QUEUE[index].wallets.includes(accountId)) {
                break;
            }
        }
        if (index < FILL_QUEUE.length) {
            const selectedOrder = FILL_QUEUE.splice(index, 1);
            try {
                await sendFillRequest(selectedOrder[0].order, accountId);
                return;
            } catch (e) {
                console.error(e);
                wallet['ORDER_BROADCASTING'] = false;
            }
        }
    }));
    setTimeout(processFillQueue, 100);
}

async function setupPriceFeeds() {
  const cryptowatch = [], chainlink = [];
    for (let market in MM_CONFIG.pairs) {
      if(!MM_CONFIG.pairs[market].active) { continue; }
      const primaryPriceFeed = MM_CONFIG.pairs[market].priceFeedPrimary;
      const secondaryPriceFeed = MM_CONFIG.pairs[market].priceFeedSecondary;
      [primaryPriceFeed, secondaryPriceFeed].forEach(priceFeed => {
          if(!priceFeed) { return; }
          const [provider, id] = priceFeed.split(':');
          switch(provider) {
              case 'cryptowatch':
                  if(!cryptowatch.includes(id)) { cryptowatch.push(id); }
                  break;
              case 'chainlink':
                  if(!chainlink.includes(id)) { chainlink.push(id); }
                  break;
              default:
                  throw new Error("Price feed provider "+provider+" is not available.")
                  break;
          }
      });
  }
  if(chainlinkSetup.length) await chainlinkSetup(chainlink);
  if(cryptowatch.length) await cryptowatchWsSetup(cryptowatch);

  console.log(PRICE_FEEDS);
}

async function cryptowatchWsSetup(cryptowatchMarketIds) {
    // Set initial prices
    const cryptowatchApiKey = process.env.CRYPTOWATCH_API_KEY || MM_CONFIG.cryptowatchApiKey;
    const cryptowatchMarkets = await fetch("https://api.cryptowat.ch/markets?apikey=" + cryptowatchApiKey).then(r => r.json());
    const cryptowatchMarketPrices = await fetch("https://api.cryptowat.ch/markets/prices?apikey=" + cryptowatchApiKey).then(r => r.json());
    for (let i in cryptowatchMarketIds) {
        const cryptowatchMarketId = cryptowatchMarketIds[i];
        try {
            const cryptowatchMarket = cryptowatchMarkets.result.find(row => row.id == cryptowatchMarketId);
            const exchange = cryptowatchMarket.exchange;
            const pair = cryptowatchMarket.pair;
            const key = `market:${exchange}:${pair}`;
            PRICE_FEEDS['cryptowatch:'+cryptowatchMarketIds[i]] = cryptowatchMarketPrices.result[key];
        } catch (e) {
            console.error("Could not set price feed for cryptowatch:" + cryptowatchMarketId);
        }
    }

    const subscriptionMsg = {
        "subscribe": {
            "subscriptions": []
        }
    }
    for (let i in cryptowatchMarketIds) {
        const cryptowatchMarketId = cryptowatchMarketIds[i];

        // first get initial price info

        subscriptionMsg.subscribe.subscriptions.push({
            "streamSubscription": {
                "resource": `markets:${cryptowatchMarketId}:trades`
            }
        })
    }
    let cryptowatch_ws = new WebSocket("wss://stream.cryptowat.ch/connect?apikey=" + cryptowatchApiKey);
    cryptowatch_ws.on('open', onopen);
    cryptowatch_ws.on('message', onmessage);
    cryptowatch_ws.on('close', onclose);
    cryptowatch_ws.on('error', console.error);

    function onopen() {
        cryptowatch_ws.send(JSON.stringify(subscriptionMsg));
    }
    function onmessage (data) {
        const msg = JSON.parse(data);
        if (!msg.marketUpdate) return;

        const marketId = "cryptowatch:" + msg.marketUpdate.market.marketId;
        let trades = msg.marketUpdate.tradesUpdate.trades;
        let price = trades[trades.length - 1].priceStr / 1;
        PRICE_FEEDS[marketId] = price;
    }
    function onclose () {
        setTimeout(cryptowatchWsSetup, 5000, cryptowatchMarketIds);
    }
}

async function chainlinkSetup(chainlinkMarketAddress) {
    chainlinkMarketAddress.forEach(async (address) => {
        try {
            const aggregatorV3InterfaceABI = JSON.parse(fs.readFileSync('chainlinkV3InterfaceABI.abi'));
            const provider = new ethers.Contract(address, aggregatorV3InterfaceABI, ethersProvider);
            const decimals = await provider.decimals();
            CHAINLINK_PROVIDERS['chainlink:'+address] = [provider, decimals];

            // get inital price
            const response = await provider.latestRoundData();
            PRICE_FEEDS['chainlink:'+address] = parseFloat(response.answer) / 10**decimals;
        } catch (e) {
            throw new Error ("Error while setting up chainlink for "+address+", Error: "+e);
        }
    });
    setInterval(chainlinkUpdate, 10000);
}

async function chainlinkUpdate() {
    await Promise.all(Object.keys(CHAINLINK_PROVIDERS).map(async (key) => {
        const [provider, decimals] = CHAINLINK_PROVIDERS[key];
        const response = await provider.latestRoundData();
        const price = parseFloat(response.answer) / 10**decimals;
    }));
}

const CLIENT_ID = (Math.random() * 100000).toString(16);
function indicateLiquidity () {
    for(const marketId in MM_CONFIG.pairs) {
        const mmConfig = MM_CONFIG.pairs[marketId];
        if(!mmConfig || !mmConfig.active) continue;

        try {
            validatePriceFeed(marketId);
        } catch(e) {
            console.error("Can not indicateLiquidity ("+marketId+") because: " + e);
            continue;
        }

        const marketInfo = MARKETS[marketId];
        if (!marketInfo) continue;

        const midPrice = getMidPrice(marketId);
        if (!midPrice) continue;

        const expires = (Date.now() / 1000 | 0) + 10; // 10s expiry
        const side = mmConfig.side || 'd';

        let maxBaseBalance = 0, maxQuoteBalance = 0;
        Object.keys(WALLETS).forEach(accountId => {
            const walletBase = WALLETS[accountId]['account_state'].committed.balances[marketInfo.baseAsset.symbol];
            const walletQuote = WALLETS[accountId]['account_state'].committed.balances[marketInfo.quoteAsset.symbol];
            if (Number(walletBase) > maxBaseBalance) {
                maxBaseBalance = walletBase;
            }
            if (Number(walletQuote) > maxQuoteBalance) {
                maxQuoteBalance = walletQuote;
            }
        });
        const baseBalance = maxBaseBalance / 10**marketInfo.baseAsset.decimals;
        const quoteBalance = maxQuoteBalance / 10**marketInfo.quoteAsset.decimals;
        const maxSellSize = Math.min(baseBalance, mmConfig.maxSize);
        const maxBuySize = Math.min(quoteBalance / midPrice, mmConfig.maxSize);

        const splits = 10;
        const liquidity = [];
        for (let i=1; i <= splits; i++) {
            const buyPrice = midPrice * (1 - mmConfig.minSpread - (mmConfig.slippageRate * maxBuySize * i/splits));
            const sellPrice = midPrice * (1 + mmConfig.minSpread + (mmConfig.slippageRate * maxSellSize * i/splits));
            if ((['b','d']).includes(side)) {
                liquidity.push(["b", buyPrice, maxBuySize / splits, expires]);
            }
            if ((['s','d']).includes(side)) {
                liquidity.push(["s", sellPrice, maxSellSize / splits, expires]);
            }
        }
        const msg = { op: "indicateliq2", args: [CHAIN_ID, marketId, liquidity, CLIENT_ID] };
        try {
            zigzagws.send(JSON.stringify(msg));
        } catch (e) {
            console.error("Could not send liquidity");
            console.error(e);
        }
    }
}

function getMidPrice (marketId) {
    const mmConfig = MM_CONFIG.pairs[marketId];
    const mode = mmConfig.mode || "pricefeed";
    let midPrice;
    if (mode == "constant") {
        midPrice = mmConfig.initPrice;
    }
    else if (mode == "pricefeed") {
        midPrice = PRICE_FEEDS[mmConfig.priceFeedPrimary];
    }
    return midPrice;
}

function activatePair(marketId) {
    const mmConfig = MM_CONFIG.pairs[marketId];
    if(!mmConfig) return;
    mmConfig.active = true;
    console.log(`Set ${market_id} active.`)
}

function rememberOrder(chainId, orderId, market, price, fillOrder) {
    const timestamp = Date.now() / 1000;
    for (const [key, value] of Object.entries(PAST_ORDER_LIST)) {
        if (value['expiry'] < timestamp) {
            delete PAST_ORDER_LIST[key];
        }
    }

    const expiry = timestamp + 900;
    PAST_ORDER_LIST[orderId] = {
        'chainId': chainId,
        'market': market,
        'price': price,
        'fillOrder': fillOrder,
        'expiry':expiry
    };
}

async function updateAccountState() {
    try {
        Object.keys(WALLETS).forEach(accountId => {
            (WALLETS[accountId]['syncWallet']).getAccountState().then((state) => {
                WALLETS[accountId]['account_state'] = state;
            })
        });
    } catch(err) {
        // pass
    }
}

async function logBalance() {
    try {
        await updateAccountState();
        // fetch all balances over all wallets per token
        const balance = {};
        Object.keys(WALLETS).forEach(accountId => {
            const committedBalaces = WALLETS[accountId]['account_state'].committed.balances;
            Object.keys(committedBalaces).forEach(token => {
                if(balance[token]) {
                    balance[token] = balance[token] + parseInt(committedBalaces[token]);
                } else {
                    balance[token] = parseInt(committedBalaces[token]);
                }
            });
        });
        // get token price and total in USD
        let sum = 0;
        await Promise.all(Object.keys(balance).map(async token => {
            const price = await syncProvider.getTokenPrice(token.toString());
            const tokenNumber = await syncProvider.tokenSet.formatToken(token, balance[token].toString())
            sum = sum + price * tokenNumber;
        }));

        // log to CVS
        const date = new Date().toISOString();
        const content = date + ";" + sum.toFixed(2) + "\n";
        fs.writeFile('price_csv.txt', content, { flag: 'a+' }, err => {});
    } catch(err) {
        // pass
    }
}
