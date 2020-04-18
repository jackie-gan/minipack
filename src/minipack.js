/**
 * 模块打包工具是将各个小的代码模块，聚合成一个大的，可以在目标环境运行的复杂代码；
 * 这些小的代码模块将由模块系统进行组织；
 * 有了模块系统，我们就能知道小的代码模块何时以及怎么被执行；
 *
 * 模块打包工具存在一个entry file的概念；
 * 这是告诉rumtime，我们的应用应该从那个地方开始执行；
 *
 * 同时entry file也是打包工具分析依赖的入口；构造依赖图谱正是从entry file开始
 *
 * mini-pack的代码是一个很简单的打包工具例子，它没有考虑很多其他情况，例如如何解决循环引用，如何缓存模块；
 */

// 读取文件使用
const fs = require('fs');
// 解析文件路径使用
const path = require('path');
// 进行AST解析，构造AST语法树
const babylon = require('babylon');
// 对AST语法树进行遍历
const traverse = require('babel-traverse').default;
// 将AST语法树转换为代码(字符串)
const {transformFromAst} = require('babel-core');

// 每个module都会有一个对应的ID
let ID = 0;

// 主要进行文件的读取，将代码解析成AST语法树以便收集依赖
function createAsset(filename) {
  // 获取代码，转换成字符串
  const content = fs.readFileSync(filename, 'utf-8');

  // 读取该文件所依赖的模块，可以通过查找文件内容中的import字符串实现，但这是一种比较笨拙的方式，
  // 这里选择使用babylon代码字符串转换为AST语法树，
  // sourceType为module表示baby使用module模式进行解析，允许代码中使用模块定义，否则，sourceType为script，
  // 但代码中使用了import或export，会出现报错
  const ast = babylon.parse(content, {
    sourceType: 'module',
  });

  // 保存本模块所依赖的子模块的相对路径，以便后续递归分析
  const dependencies = [];

  // 遍历AST语法树，在ImportDeclaration的visitor中，收集依赖
  traverse(ast, {
    ImportDeclaration: ({node}) => {
      // 保存在dependencies数组中
      dependencies.push(node.source.value);
    },
  });

  // 赋予模块一个id
  const id = ID++;

  // 为了兼容在更多的更多的浏览器中，将使用preset-env对代码的语法进行兼容处理
  const {code} = transformFromAst(ast, null, {
    presets: ['env'],
  });

  // 返回模块的基本信息
  return {
    id,
    filename,
    dependencies,
    code,
  };
}

// 建立依赖图谱，从一个模块分析出它的依赖，然后对它的依赖的依赖再继续分析下去，也即递归分析依赖，直到所有的模块都被分析了
// 依赖图谱的存在，用于表示模块之间是如何相互依赖的
function createGraph(entry) {
  // 从入口js开始分析
  const mainAsset = createAsset(entry);

  // 使用一个队列去表示依赖图谱，队列保存所有分析过的模块
  const queue = [mainAsset];

  // 使用for of遍历所有的模块，在分析模块的过程中，遇到模块的依赖的子模块，就将新的子模块进行分析，并将分析后的结果，放到queue中
  for (const asset of queue) {
    // 每个模块(asset)都有一个子模块的列表，列表的key为子模块的相对路径，value为对应的模块id
    asset.mapping = {};

    const dirname = path.dirname(asset.filename);

    // 遍历当前asset的所有依赖
    asset.dependencies.forEach(relativePath => {
      const absolutePath = path.join(dirname, relativePath);

      // 分析依赖，得到依赖的信息
      const child = createAsset(absolutePath);

      // 将子模块的id添加到当前模块(asset)的子模块列表中
      asset.mapping[relativePath] = child.id;

      // 将该子模块添加到队列中，以便继续对该子模块的依赖进行分析
      queue.push(child);
    });
  }

  // 分析完该应用的所有模块，返回这个分析后的依赖图谱
  return queue;
}

// 根据依赖图谱进行打包；
// 构造可以在浏览器中执行的运行环境，这里用一个立即执行函数来表示；
// 立即执行函数也即runtime函数；
// runtime函数中定义好模块导出和模块引入的方法，用于被依赖图谱中的模块执行；
function bundle(graph) {
  let modules = '';

  // 由于runtime函数接收一个参数，这个参数是一个对象，这个对象描述应用中的所有依赖；
  // 这个对象正是我们的依赖图谱；
  // 这里将构造这一个参数；
  graph.forEach(mod => {
    // 这里每个key为模块的id，value为一个数组；
    // 数组的第一个元素是一个函数，这是因为我们需要function作用域名来实现模块；
    // 形参为cjs代码(代码编译后，为cjs)所需要的模块加载函数(require)与对象引用(module, export)；
    // 第二个元素是一个对象，描述的是子依赖和对应的模块id
    modules += `${mod.id}: [
      function (require, module, exports) {
        ${mod.code}
      },
      ${JSON.stringify(mod.mapping)},
    ],`;
  });

  // 这里，实现了自执行的runtime函数，函数接收一个modules参数，也即应用中的所有模块；
  // 其次里面定义了require函数，它接收一个模块id参数，然后根据id从modules中获取模块；
  // 继续执行模块中的代码，由于模块是cjs的代码，因此会使用require和export导入和导出对象，所以需要提供导入和导出方法给模块使用；
  // 执行了模块代码后，获取模块中导出的对象，并将导出的对象返回；
  //
  // localRequire是一个辅助函数，接收一个相对路径的形参；
  // 方法中从mapping对象中的相对路径获取对应的id，再继续调用require函数
  // 这个辅助函数是提供给模块内部的导入方法；
  //
  // module是一个导出对象，用于保存模块内需要导出的对象；
  //
  // require(0)表示，引用是从id为0的模块开始执行；
  const result = `
    (function(modules) {
      function require(id) {
        const [fn, mapping] = modules[id];

        function localRequire(name) {
          return require(mapping[name]);
        }

        const module = { exports : {} };

        fn(localRequire, module, module.exports);

        return module.exports;
      }

      require(0);
    })({${modules}})
  `;

  return result;
}

const graph = createGraph('./example/entry.js');
console.log(graph);
const result = bundle(graph);

console.log(result);
