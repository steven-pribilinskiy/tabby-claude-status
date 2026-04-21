const path = require('path')

module.exports = {
  target: 'node',
  entry: './src/index.ts',
  devtool: 'source-map',
  context: __dirname,
  output: {
    filename: 'index.js',
    path: path.resolve(__dirname, 'dist'),
    library: {
      type: 'umd',
    },
    globalObject: 'this',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    modules: ['node_modules'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'ts-loader',
        options: {
          transpileOnly: true,
        },
      },
    ],
  },
  externals: {
    '@angular/common': 'commonjs @angular/common',
    '@angular/core': 'commonjs @angular/core',
    '@angular/forms': 'commonjs @angular/forms',
    'tabby-core': 'commonjs tabby-core',
    'tabby-terminal': 'commonjs tabby-terminal',
    'tabby-settings': 'commonjs tabby-settings',
    'tabby-local': 'commonjs tabby-local',
    '@electron/remote': 'commonjs @electron/remote',
    electron: 'commonjs electron',
    rxjs: 'commonjs rxjs',
    fs: 'commonjs fs',
    os: 'commonjs os',
    path: 'commonjs path',
    stream: 'commonjs stream',
    http: 'commonjs http',
    https: 'commonjs https',
    url: 'commonjs url',
    util: 'commonjs util',
    child_process: 'commonjs child_process',
  },
}
