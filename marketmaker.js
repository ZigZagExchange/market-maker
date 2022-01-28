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
let ACCOUNT_STATE = null;

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

// Start price feeds
cryptowatchWsSetup();

// Initiate fill loop
let ORDER_BROADCASTING = false;
const FILL_QUEUE = [];
setTimeout(processFillQueue, 1000);

// Connect to zksync
const CHAIN_ID = parseInt(MM_CONFIG.zigzagChainId);
const ETH_NETWORK = (CHAIN_ID === 1) ? "mainnet" : "rinkeby";
let syncWallet, ethersProvider, syncProvider, ethWallet, 
    fillOrdersInterval, indicateLiquidityInterval;
ethersProvider = ethers.getDefaultProvider(ETH_NETWORK);
try {
    syncProvider = await zksync.getDefaultProvider(ETH_NETWORK);
    ethWallet = new ethers.Wallet(process.env.ETH_PRIVKEY || MM_CONFIG.ethPrivKey);
    syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
    if (!(await syncWallet.isSigningKeySet())) {
        console.log("setting sign key");
        const signKeyResult = await syncWallet.setSigningKey({
            feeToken: "ETH",
            ethAuthType: "ECDSA",
        });
        console.log(signKeyResult);
    }
} catch (e) {
    console.log(e);
    throw new Error("Could not connect to zksync API");
}

// Update account state loop
await updateAccountState();
setInterval(updateAccountState, 30000);

// Get markets info
const activePairsText = activePairs.join(',');
const markets_url = `https://zigzag-markets.herokuapp.com/markets?chainid=${CHAIN_ID}&id=${activePairsText}`
const markets = await fetch(markets_url).then(r => r.json());
if (markets.error) {
    console.error(markets);
    throw new Error(markets.error);
}
const MARKETS = {};
for (let i in markets) {
    const market = markets[i];
    MARKETS[market.id] = market;
    if (market.alias) {
        MARKETS[market.alias] = market;
    }
}

let zigzagws = new WebSocket(MM_CONFIG.zigzagWsUrl);
zigzagws.on('open', onWsOpen);
zigzagws.on('error', console.error);

function onWsOpen() {
    zigzagws.on('message', handleMessage);
    zigzagws.on('close', onWsClose);
    fillOrdersInterval = setInterval(fillOpenOrders, 5000);
    for (let market in MM_CONFIG.pairs) {
        if (MM_CONFIG.pairs[market].active) {
            indicateLiquidityInterval = setInterval(() => indicateLiquidity(market), 5000);
            const msg = {op:"subscribemarket", args:[CHAIN_ID, market]};
            // There's a weird bug happening where even though the websocket is open the message isn't going through 
            // so a time delay was set
            setTimeout(() => zigzagws.send(JSON.stringify(msg)), 100);
        }
    }
}
    
function onWsClose () {
    console.log("Websocket closed. Restarting");
    ORDER_BROADCASTING = false;
    setTimeout(() => {
        clearInterval(fillOrdersInterval)
        clearInterval(indicateLiquidityInterval)
        zigzagws = new WebSocket(MM_CONFIG.zigzagWsUrl);
        zigzagws.on('open', onWsOpen);
        zigzagws.on('error', onWsClose);
    }, 5000);
}

async function handleMessage(json) {
    const msg = JSON.parse(json);
    if (!(["lastprice", "liquidity2"]).includes(msg.op)) console.log(json.toString());
    switch(msg.op) {
        case 'error':
            ORDER_BROADCASTING = false;
            break;
        case 'orders':
            const orders = msg.args[0];
            orders.forEach(order => {
                const orderid = order[1];
                const fillable = isOrderFillable(order);
                console.log(fillable);
                if (fillable.fillable) {
                    FILL_QUEUE.push(order);
                }
                else if (fillable.reason === "badprice") {
                    OPEN_ORDERS[orderid] = order;
                }
            });
            break
        case "userordermatch":
            const chainid = msg.args[0];
            const orderid = msg.args[1];
            try {
                await broadcastfill(chainid, orderid, msg.args[2], msg.args[3]);
            } catch (e) {
                console.error(e);
            }
            ORDER_BROADCASTING = false;
            break
        default:
            break
    }
}

function isOrderFillable(order) {
    const chainid = order[0];
    const market_id = order[2];
    const market = MARKETS[market_id];
    const mmConfig = MM_CONFIG.pairs[market_id];
    const mmSide = mmConfig.side || 'd';
    if (chainid != CHAIN_ID) return { fillable: false, reason: "badchain" }
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
    const balance = ACCOUNT_STATE.committed.balances[sellCurrency] / 10**sellDecimals;
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

    if (balance < sellQuantity) {
        return { fillable: false, reason: "badbalance" };
    }

    let quote;
    try {
        quote = genquote(chainid, market_id, side, baseQuantity);
    } catch (e) {
        return { fillable: false, reason: e.message }
    }

    if (side == 's' && price > quote.quotePrice) {
        return { fillable: false, reason: "badprice" };
    }
    else if (side == 'b' && price < quote.quotePrice) {
        return { fillable: false, reason: "badprice" };
    }

    return { fillable: true, reason: null };
}

function genquote(chainid, market_id, side, baseQuantity) {
    const market = MARKETS[market_id];
    if (CHAIN_ID !== chainid) throw new Error("badchain");
    if (!market) throw new Error("badmarket");
    if (!(['b','s']).includes(side)) throw new Error("badside");
    if (baseQuantity <= 0) throw new Error("badquantity");

    validatePriceFeed(market_id);

    const mmConfig = MM_CONFIG.pairs[market_id];
    const mmSide = mmConfig.side || 'd';
    if (mmConfig.side !== 'd' && mmConfig.side === side) {
        throw new Error("badside");
    }
    const primaryPrice = getMidPrice(market_id);
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

function validatePriceFeed(market_id) {
    const mmConfig = MM_CONFIG.pairs[market_id];
    const mode = MM_CONFIG.pairs[market_id].mode || "pricefeed";
    const initPrice = MM_CONFIG.pairs[market_id].initPrice;
    const primaryPriceFeedId = MM_CONFIG.pairs[market_id].priceFeedPrimary;
    const secondaryPriceFeedId = MM_CONFIG.pairs[market_id].priceFeedSecondary;

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

async function sendfillrequest(orderreceipt) {
  const chainId = orderreceipt[0];
  const orderId = orderreceipt[1];
  const market_id = orderreceipt[2];
  const market = MARKETS[market_id];
  const baseCurrency = market.baseAssetId;
  const quoteCurrency = market.quoteAssetId;
  const side = orderreceipt[3];
  const baseQuantity = orderreceipt[5];
  const quoteQuantity = orderreceipt[6];
  const quote = genquote(chainId, market_id, side, baseQuantity);
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
  const one_min_expiry = (Date.now() / 1000 | 0) + 60;
  const orderDetails = {
    tokenSell,
    tokenBuy,
    amount: sellQuantityPacked,
    ratio: zksync.utils.tokenRatio(tokenRatio),
    validUntil: one_min_expiry
  }
  const fillOrder = await syncWallet.getOrder(orderDetails);
    
  // Set global flag 
  ORDER_BROADCASTING = true;

  const resp = { op: "fillrequest", args: [chainId, orderId, fillOrder] };
  zigzagws.send(JSON.stringify(resp));
}

async function broadcastfill(chainid, orderid, swapOffer, fillOrder) {
  console.log(swapOffer, fillOrder);
  const randint = (Math.random()*1000).toFixed(0);
  console.time('syncswap' + randint);
  const swap = await syncWallet.syncSwap({
    orders: [swapOffer, fillOrder],
    feeToken: "ETH",
    nonce: fillOrder.nonce
  });
  const txhash = swap.txHash.split(":")[1];
  const txhashmsg = {op:"orderstatusupdate", args:[[[chainid,orderid,'b',txhash]]]}
  zigzagws.send(JSON.stringify(txhashmsg));
  console.timeEnd('syncswap' + randint);

  console.time('receipt' + randint);
  let receipt, success;
  try {
    receipt = await swap.awaitReceipt();
    if (receipt.success) success = true;
  } catch (e) {
    receipt = null;
    success = false;
  }
  console.timeEnd('receipt' + randint);

  console.log("Swap broadcast result", {swap, receipt});
  const newstatus = success ? 'f' : 'r';
  const error = success ? null : swap.error.toString();
  const ordercommitmsg = {op:"orderstatusupdate", args:[[[chainid,orderid,newstatus,txhash,error]]]}
  zigzagws.send(JSON.stringify(ordercommitmsg));
}

async function fillOpenOrders() {
    for (let orderid in OPEN_ORDERS) {
        const order = OPEN_ORDERS[orderid];
        const fillable = isOrderFillable(order);
        if (fillable.fillable) {
            FILL_QUEUE.push(order);
            delete OPEN_ORDERS[orderid];
        }
        else if (fillable.reason !== "badprice") {
            delete OPEN_ORDERS[orderid];
        }
    }
}

async function processFillQueue() {
    if (ORDER_BROADCASTING) {
        setTimeout(processFillQueue, 100);
        return false;
    }
    if (FILL_QUEUE.length === 0) {
        setTimeout(processFillQueue, 100);
        return false;
    }
    const order = FILL_QUEUE.shift();
    try {
        await sendfillrequest(order);
    } catch (e) {
        console.error(e);
        ORDER_BROADCASTING = false;
    }
    setTimeout(processFillQueue, 50);
}

async function cryptowatchWsSetup() {
    const cryptowatch_market_ids = [];
    for (let market in MM_CONFIG.pairs) {
        const primaryPriceFeed = MM_CONFIG.pairs[market].priceFeedPrimary;
        const secondaryPriceFeed = MM_CONFIG.pairs[market].priceFeedSecondary;
        if (primaryPriceFeed) cryptowatch_market_ids.push(primaryPriceFeed);
        if (secondaryPriceFeed) cryptowatch_market_ids.push(secondaryPriceFeed);
    }

    // Set initial prices
    const cryptowatchApiKey = process.env.CRYPTOWATCH_API_KEY || MM_CONFIG.cryptowatchApiKey;
    const cryptowatch_markets = await fetch("https://api.cryptowat.ch/markets?apikey=" + cryptowatchApiKey).then(r => r.json());
    const cryptowatch_market_prices = await fetch("https://api.cryptowat.ch/markets/prices?apikey=" + cryptowatchApiKey).then(r => r.json());
    for (let i in cryptowatch_market_ids) {
        const cryptowatch_market_id = cryptowatch_market_ids[i].split(":")[1];
        const cryptowatch_market = cryptowatch_markets.result.find(row => row.id == cryptowatch_market_id);
        const exchange = cryptowatch_market.exchange;
        const pair = cryptowatch_market.pair;
        const key = `market:${exchange}:${pair}`;
        PRICE_FEEDS[cryptowatch_market_ids[i]] = cryptowatch_market_prices.result[key];
    }
    console.log(PRICE_FEEDS);

    const subscriptionMsg = {
      "subscribe": {
        "subscriptions": []
      }
    }
    for (let i in cryptowatch_market_ids) {
        const cryptowatch_market_id = cryptowatch_market_ids[i].split(":")[1];

        // first get initial price info

        subscriptionMsg.subscribe.subscriptions.push({
          "streamSubscription": {
            "resource": `markets:${cryptowatch_market_id}:trades`
          }
        })
    }
    let cryptowatch_ws = new WebSocket("wss://stream.cryptowat.ch/connect?apikey=" + cryptowatchApiKey);
    cryptowatch_ws.on('open', onopen);
    cryptowatch_ws.on('message', onmessage);
    cryptowatch_ws.on('close', onclose);
    function onopen() {
        cryptowatch_ws.send(JSON.stringify(subscriptionMsg));
    }
    function onmessage (data) {
        const msg = JSON.parse(data);
        if (!msg.marketUpdate) return;

        const market_id = "cryptowatch:" + msg.marketUpdate.market.marketId;
        let trades = msg.marketUpdate.tradesUpdate.trades;
        let price = trades[trades.length - 1].priceStr / 1;
        PRICE_FEEDS[market_id] = price;
    };
    function onclose () {
        setTimeout(cryptowatchWsSetup, 5000);
    }
}

const CLIENT_ID = (Math.random() * 100000).toString(16);
function indicateLiquidity (market_id) {
    try {
        validatePriceFeed(market_id);
    } catch(e) {
        return false;
    }

    const marketInfo = MARKETS[market_id];
    const mmConfig = MM_CONFIG.pairs[market_id];
    const midPrice = getMidPrice(market_id);
    const expires = (Date.now() / 1000 | 0) + 10; // 10s expiry
    const side = mmConfig.side || 'd';
    const baseBalance = ACCOUNT_STATE.committed.balances[marketInfo.baseAsset.symbol] / 10**marketInfo.baseAsset.decimals;
    const quoteBalance = ACCOUNT_STATE.committed.balances[marketInfo.quoteAsset.symbol] / 10**marketInfo.quoteAsset.decimals;
    const maxSellSize = Math.min(baseBalance, mmConfig.maxSize);
    const maxBuySize = Math.min(quoteBalance, (mmConfig.maxSize * midPrice));
    if (!midPrice) return false;

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
    const msg = { op: "indicateliq2", args: [CHAIN_ID, market_id, liquidity, CLIENT_ID] };
    zigzagws.send(JSON.stringify(msg));
}

function getMidPrice (market_id) {
    const mmConfig = MM_CONFIG.pairs[market_id];
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

async function updateAccountState() {
    ACCOUNT_STATE = await syncWallet.getAccountState();
}
