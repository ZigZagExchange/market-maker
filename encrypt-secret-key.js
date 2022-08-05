import CryptoJS from 'crypto-js'
import readlineSync from 'readline-sync'

function encrypt() {
    var ethPrivKey = readlineSync.question('please input eth private key: ',{hideEchoBack: true});
    var cryptowatchKey = readlineSync.question('please input cryptowatch key: ',{hideEchoBack: true});
    var passwd = readlineSync.question('please input your password: ',{hideEchoBack: true});
    var verifypasswd = readlineSync.question('please reinput your password: ',{hideEchoBack: true});

    if (passwd != verifypasswd) {
        console.log("your password mistach!")
        return
    }
    var encryptEthPrivKey = CryptoJS.AES.encrypt(ethPrivKey, passwd).toString();
    var encryptCryptowatchKey = CryptoJS.AES.encrypt(cryptowatchKey, passwd).toString();

    console.log("your encrypted eth private key: ", encryptEthPrivKey)
    console.log("your encrypted cryptowatch key: ", encryptCryptowatchKey)
}

eval(encrypt())

