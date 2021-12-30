import WebSocket from 'ws';
import * as zksync from "zksync";
import ethers from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

// Initiate fill loop
let ORDER_BROADCASTING = false;
const FILL_QUEUE = [];
setTimeout(processFillQueue, 1000);

let syncWallet, ethersProvider, syncProvider, ethWallet, 
    fillOrdersInterval, accountState;
ethersProvider = ethers.getDefaultProvider(process.env.ETH_NETWORK);
try {
    syncProvider = await zksync.getDefaultProvider(process.env.ETH_NETWORK);
    ethWallet = new ethers.Wallet(process.env.ETH_PRIVKEY);
    syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
    if (!(await syncWallet.isSigningKeySet())) {
        console.log("setting sign key");
        const signKeyResult = await syncWallet.setSigningKey({
            feeToken: "ETH",
            ethAuthType: "ECDSA",
        });
        console.log(signKeyResult);
    }
    accountState = await syncWallet.getAccountState();
} catch (e) {
    console.log(e);
    throw new Error("Could not connect to zksync API");
}

const spotPrices = {};
const OPEN_ORDERS = {};

const CHAIN_ID = parseInt(process.env.CHAIN_ID);
const MARKET_PAIRS = process.env.PAIR_WHITELIST.split(",")
console.log("PAIR WHITELIST: ", process.env.PAIR_WHITELIST);

const CURRENCY_INFO = {
    "ETH": { 
        decimals: 18, 
        chain: { 
            1: { tokenId: 0 },
            1000: { tokenId: 0 },
        },
        gasFee: 0.0003,
    },
    "WETH": { 
        decimals: 18, 
        chain: { 
            1: { tokenId: 61 },
        },
        gasFee: 0.0003,
    },
    "USDC": { 
        decimals: 6, 
        chain: { 
            1: { tokenId: 2 },
            1000: { tokenId: 2 },
        },
        gasFee: 1,
    },
    "USDT": { 
        decimals: 6, 
        chain: { 
            1: { tokenId: 4 },
            1000: { tokenId: 1 },
        },
        gasFee: 1,
    },
    "DAI": {
        decimals: 18,
        chain: {
            1: { tokenId: 1 },
            1000: { tokenId: 19 },
        },
        gasFee: 1,
    },
    "WBTC": {
        decimals: 8,
        chain: {
            1: { tokenId: 15 },
            1000: { tokenId: null },
        },
        gasFee: 0.00003,
    },
}

let zigzagws = new WebSocket(process.env.ZIGZAG_WS_URL);
zigzagws.on('open', onWsOpen);

function onWsOpen() {
    zigzagws.on('message', handleMessage);
    zigzagws.on('close', onWsClose);
    fillOrdersInterval = setInterval(fillOpenOrders, 10000);
    MARKET_PAIRS.forEach(market => {
        const msg = {op:"subscribemarket", args:[CHAIN_ID, market]};
        zigzagws.send(JSON.stringify(msg));
    });
}
    
function onWsClose () {
    console.log("Websocket closed. Restarting");
    ORDER_BROADCASTING = false;
    setTimeout(() => {
        clearInterval(fillOrdersInterval)
        zigzagws = new WebSocket(process.env.ZIGZAG_WS_URL);
        zigzagws.on('open', onWsOpen);
        zigzagws.on('error', onWsClose);
    }, 5000);
}

async function handleMessage(json) {
    const msg = JSON.parse(json);
    if (msg.op != "lastprice") console.log(json.toString());
    switch(msg.op) {
        case 'error':
            ORDER_BROADCASTING = false;
            break;
        case 'lastprice':
            const prices = msg.args[0];
            prices.forEach(row => {
                const market = row[0];
                const price = row[1];
                spotPrices[market] = price;
            });
            break
        case 'orders':
            const orders = msg.args[0];
            orders.forEach(order => {
                const orderid = order[1];
                const fillable = isOrderFillable(order);
                console.log(fillable);
                if (fillable.fillable) {
                    FILL_QUEUE.push(order);
                }
                else if (fillable.error === "badprice") {
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
    const market = order[2];
    const baseCurrency = market.split("-")[0];
    const quoteCurrency = market.split("-")[1];
    const baseQuantity = order[5];
    const quoteQuantity = order[6];
    const expires = order[7];
    const side = order[3];
    const price = order[4];
    const now = Date.now() / 1000 | 0;
    if (chainid != CHAIN_ID || !MARKET_PAIRS.includes(market)) {
        return { fillable: false, reason: "unsupported", code: 1 };
    }

    if (now > expires) {
        return { fillable: false, reason: "expired", code: 2 };
    }

    let quote;
    try {
        quote = genquote(chainid, market, side, baseQuantity, quoteQuantity);
    } catch (e) {
        return { fillable: false, reason: e.message, code: 5 }
    }

    if (side == 's' && price > quote.hardPrice) {
        return { fillable: false, reason: "badprice", code: 3 };
    }
    else if (side == 'b' && price < quote.hardPrice) {
        return { fillable: false, reason: "badprice", code: 3 };
    }

    const MIN_DOLLAR_SIZE = process.env.MIN_DOLLAR_SIZE;
    const MAX_DOLLAR_SIZE = process.env.MAX_DOLLAR_SIZE;
    let order_dollar_size;
    if ((["USDC", "FRAX", "USDT", "DAI"]).includes(quoteCurrency)) {
        order_dollar_size = quoteQuantity;
    }
    if ((["ETH", "WBTC", "WETH"]).includes(quoteCurrency)) {
        const quoteDollarMarket = baseCurrency + "-USDT";
        const quotePrice = spotPrices[quoteDollarMarket];
        order_dollar_size = quoteQuantity * quotePrice;
    }

    if (order_dollar_size < MIN_DOLLAR_SIZE) {
        console.log("order too small to fill. Ignoring");
        return { fillable: false, reason: "badsize", code: 4 };
    }
    if (order_dollar_size > MAX_DOLLAR_SIZE) { 
        console.log("order too large to fill. Ignoring");
        return { fillable: false, reason: "badsize", code: 4 };
    }

    return { fillable: true, reason: null, code: 0 };
}

function genquote(chainid, market, side, baseQuantity) {
    if (CHAIN_ID !== chainid) throw new Error("Invalid chain");
    if (!MARKET_PAIRS.includes(market)) throw new Error("Invalid market");
    if (!(['b','s']).includes(side)) throw new Error("Invalid side");
    if (baseQuantity <= 0) throw new Error("Quantity must be positive");

    const lastPrice = spotPrices[market];
    let SOFT_SPREAD, HARD_SPREAD;
    const baseCurrency = market.split("-")[0];
    const quoteCurrency = market.split("-")[1];
    if ((["USDC", "USDT", "FRAX", "DAI"]).includes(baseCurrency)) {
        SOFT_SPREAD = 0.0006;
        HARD_SPREAD = 0.0003;
    }
    else {
        SOFT_SPREAD = 0.001;
        HARD_SPREAD = 0.0005;
    }
    let softQuoteQuantity, hardQuoteQuantity;
    if (baseQuantity && side === 'b') {
        softQuoteQuantity = (baseQuantity * lastPrice * (1 + SOFT_SPREAD)) + CURRENCY_INFO[quoteCurrency].gasFee;
        hardQuoteQuantity = (baseQuantity * lastPrice * (1 + HARD_SPREAD)) + CURRENCY_INFO[quoteCurrency].gasFee;
    }
    else if (baseQuantity && side === 's') {
        softQuoteQuantity = (baseQuantity - CURRENCY_INFO[baseCurrency].gasFee) * lastPrice * (1 - SOFT_SPREAD);
        hardQuoteQuantity = (baseQuantity - CURRENCY_INFO[baseCurrency].gasFee) * lastPrice * (1 - HARD_SPREAD);
    }
    const softPrice = (softQuoteQuantity / baseQuantity).toPrecision(6);
    const hardPrice = (hardQuoteQuantity / baseQuantity).toPrecision(6);;
    if (softPrice < 0  || hardPrice < 0) throw new Error("Amount is inadequate to pay fee");
    if (isNaN(softPrice)  || isNaN(hardPrice)) throw new Error("Internal Error. No price generated.");
    return { softPrice, hardPrice, softQuoteQuantity, hardQuoteQuantity };
}

async function sendfillrequest(orderreceipt) {
  const chainId = orderreceipt[0];
  const orderId = orderreceipt[1];
  const market = orderreceipt[2];
  const baseCurrency = market.split("-")[0];
  const quoteCurrency = market.split("-")[1];
  const side = orderreceipt[3];
  let price = orderreceipt[4];
  const baseQuantity = orderreceipt[5];
  const quoteQuantity = orderreceipt[6];
  let tokenSell, tokenBuy, sellQuantity;
  if (side === "b") {
    tokenSell = baseCurrency;
    tokenBuy = quoteCurrency;
    if (tokenSell === "ETH") {
        sellQuantity = (baseQuantity * 1.0001).toPrecision(10);
    }
    else if (tokenSell === "WBTC") {
        sellQuantity = parseFloat((baseQuantity * 1.0001).toFixed(8)).toPrecision(8);
    }
    else {
        sellQuantity = parseFloat((baseQuantity * 1.0001).toFixed(6)).toPrecision(6);
    }
  } else if (side === "s") {
    tokenSell = quoteCurrency;
    tokenBuy = baseCurrency;
    if (tokenSell === "WBTC") {
        sellQuantity = parseFloat((quoteQuantity * 1.0001).toFixed(8)).toPrecision(8);
    }
    else {
        sellQuantity = parseFloat((quoteQuantity * 1.0001).toFixed(6)).toPrecision(8); // Add a margin of error to sellQuantity, max 6 decimal places, max 8 digits
    }
  }
  sellQuantity = syncProvider.tokenSet.parseToken(
    tokenSell,
    sellQuantity.toString()
  );
  sellQuantity = zksync.utils.closestPackableTransactionAmount(sellQuantity);
  const tokenRatio = {};
  tokenRatio[baseCurrency] = 1;
  tokenRatio[quoteCurrency] = parseFloat(spotPrices[market].toFixed(6));
  console.log(`${side} ${baseQuantity} ${baseCurrency} @ ${price}`);
  const one_min_expiry = (Date.now() / 1000 | 0) + 60;
  const orderDetails = {
    tokenSell,
    tokenBuy,
    amount: sellQuantity,
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
        else if (fillable.error !== "badprice") {
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
