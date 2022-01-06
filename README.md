# Configuration File

Copy the `config.json.EXAMPLE` file to `config.json` to get started. 

Set your `eth_privkey` to be able to relay transactions. The ETH address with that private key should be loaded up with adequate funds for market making.

You can add, remove, and configure pair settings in the `pairs` section.

# Configuration Via Environment Variables

If your hosting service requires you to pass in configs via environment variables you can compress `config.json`:

```
cat config.json | tr -d ' ' | tr -d '\n'
```

and set it to the value of the `MM_CONFIG` environment variable to override the config file.

You can also override the private key in the config file with the `ETH_PRIVKEY` environment variable.
