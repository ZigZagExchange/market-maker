import WebSocket from 'ws';
import * as zksync from "zksync";
import ethers from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

let syncWallet, ethersProvider, syncProvider, ethWallet;
ethersProvider = ethers.getDefaultProvider(process.env.ETH_NETWORK);
try {
    syncProvider = await zksync.getDefaultProvider(process.env.ETH_NETWORK);
    ethWallet = new ethers.Wallet(process.env.ETH_PRIVKEY);
    syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
} catch (e) {
    throw new Error("Could not connect to zksync API");
}

const accountState = await syncWallet.getAccountState();
console.log(accountState);
let currentNonce = accountState.committed.nonce;

const spotPrices = {};
const openOrders = {};

const broadcastQueue = [];
processBroadcastQueueLoop(); // Start the loop

const CHAIN_ID = 1;
const MARKET_PAIRS = ["ETH-USDT", "ETH-USDC", "USDC-USDT"];
const CURRENCY_INFO = {
    "ETH": { 
        decimals: 18, 
        chain: { 
            1: { tokenId: 0 },
            1000: { tokenId: 0 },
        }
    },
    "USDC": { 
        decimals: 6, 
        chain: { 
            1: { tokenId: 2 },
            1000: { tokenId: 2 },
        }
    },
    "USDT": { 
        decimals: 6, 
        chain: { 
            1: { tokenId: 4 },
            1000: { tokenId: 1 },
        }
    },
}

let zigzagws = new WebSocket(process.env.ZIGZAG_WS_URL);
zigzagws.on('open', function open() {
    setInterval(pingServer, 5000);
    setInterval(fillOpenOrders, 10000);
    MARKET_PAIRS.forEach(market => {
        const msg = {op:"subscribemarket", args:[CHAIN_ID, market]};
        zigzagws.send(JSON.stringify(msg));
    });
});
zigzagws.on('message', handleMessage);
zigzagws.on('close', () => {
    setInterval(() => {
        zigzagws = new WebSocket(process.env.ZIGZAG_WS_URL);
    }, 5000);
})

function pingServer() {
    const msg = {op:"ping"};
    zigzagws.send(JSON.stringify(msg));
}

async function handleMessage(json) {
    console.log(json.toString());
    const msg = JSON.parse(json);
    switch(msg.op) {
        case 'pong':
            break
        case 'lastprice':
            const prices = msg.args[0];
            prices.forEach(row => {
                const market = row[0];
                const price = row[1];
                spotPrices[market] = price;
            });
            break
        case 'openorders':
            const orders = msg.args[0];
            orders.forEach(order => {
                const orderid = order[1];
                if (isOrderFillable(order)) {
                    sendfillrequest(order);
                }
                else {
                    openOrders[orderid] = order;
                }
            });
            break
        case "userordermatch":
            const chainid = msg.args[0];
            const orderid = msg.args[1];
            broadcastQueue.push([chainid, orderid, msg.args[2], msg.args[3]]);
            break
        case "cancelorderack":
            const canceled_ids = msg.args[0];
            canceled_ids.forEach(orderid => {
                delete openOrders[orderid]
            });
            break
        default:
            break
    }
}

function isOrderFillable(order) {
    const chainid = order[0];
    const market = order[2];
    if (chainid != CHAIN_ID || !MARKET_PAIRS.includes(market)) {
        return false;
    }

    const spotPrice = spotPrices[market];
    if (!spotPrice) return false;
    const botAsk = spotPrice * 1.001;
    const botBid = spotPrice * 0.999;

    const side = order[3];
    const price = order[4];
    if (side == 's' && price < botBid) {
        return true;
    }
    else if (side == 'b' && price > botAsk) {
        return true;
    }
    return false;
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
    price = price * 0.9997; // Add a margin of error to price
    tokenSell = baseCurrency;
    tokenBuy = quoteCurrency;
    sellQuantity = baseQuantity.toString();
  } else if (side === "s") {
    price = price * 1.0003; // Add a margin of error to price
    tokenSell = quoteCurrency;
    tokenBuy = baseCurrency;
    sellQuantity = (quoteQuantity * 1.0001).toFixed(6); // Add a margin of error to sellQuantity
  }
  const tokenRatio = {};
  tokenRatio[baseCurrency] = 1;
  tokenRatio[quoteCurrency] = parseFloat(price.toFixed(6));
  console.log(sellQuantity);
  console.log(tokenRatio);
  const fillOrder = await syncWallet.getOrder({
    tokenSell,
    tokenBuy,
    amount: syncProvider.tokenSet.parseToken(
      tokenSell,
      sellQuantity
    ),
    ratio: zksync.utils.tokenRatio(tokenRatio),
    nonce: ++currentNonce
  });
  console.log(currentNonce);
  const resp = { op: "fillrequest", args: [chainId, orderId, fillOrder] };
  zigzagws.send(JSON.stringify(resp));
}

async function fillOpenOrders() {
    for (let orderid in openOrders) {
        const order = openOrders[orderid];
        if (isOrderFillable(order)) {
            sendfillrequest(order);
            delete openOrders[orderid];
        }
    }
}

async function processBroadcastQueueLoop() {
    const row = broadcastQueue.shift();
    if (row) {
        const chainid = row[0];
        const orderid = row[1];
        const swapOffer = row[2];
        const fillOrder = row[3];

        const randint = (Math.random()*1000).toFixed(0);

        let receipt, swap;
        try {
            console.time('syncswap' + randint);
            swap = await syncWallet.syncSwap({
              orders: [swapOffer, fillOrder],
              feeToken: "ETH",
            });
            console.timeEnd('syncswap' + randint);

            console.time('receipt' + randint);
            receipt = await swap.awaitReceipt();
            console.timeEnd('receipt' + randint);
        } catch (e) {
            console.error(e);
        }
        const success = (receipt && receipt.success);

        if (swap) {
            console.log("Swap broadcast result", swap, receipt);
            const newstatus = success ? 'f' : 'r';
            const txhash = swap.txHash.split(":")[1];
            const error = success ? null : swap.error.toString();
            const ordercommitmsg = {op:"orderstatusupdate", args:[[[chainid,orderid,newstatus,txhash,error]]]}
            zigzagws.send(JSON.stringify(ordercommitmsg));
        }
        else {
            console.error("Failed to broadcast order");
        }
    }

    setTimeout(processBroadcastQueueLoop, 100);
}
