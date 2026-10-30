# Agent Note: PTC 原始文本字面量与解析位置

Status: implemented

[English](2026-10-30-ptc-raw-text-and-parse-locations.md) | 中文

## 问题

PTC-only 工具要求模型先将文件内容或嵌入脚本放入 TypeScript 字符串字面量，再将程序放入工具调用 JSON。本地使用中观察到的转义失败发生在 JSON 解码后的 TypeScript 源码中；外层 JSON 参数仍然合法。典型情况包括普通引号字符串中的真实换行、内层引号与外层相同，以及模板反引号多转义一层。TypeScript 层在写文件前解释原本要保留的 `\n`，也可能静默改变嵌入代码。

JavaScript 和 TypeScript 没有不受分隔符限制、可直接容纳任意文本的字符串语法。`String.raw` 仍保留反引号和 `${` 的特殊含义。[PTC 基础](2026-06-15-ptc.zh.md)负责工具呈现与分派；本决策只扩展 Node 提供方的程序语言和解析诊断。

在 Node 24.19 中，`stripTypeScriptTypes` 的解析错误提供 message 和 code，但没有源码位置。以下最小示例无需模型或凭据即可独立复现：

```js
import { stripTypeScriptTypes } from 'node:module'
try {
  stripTypeScriptTypes('const text = ;')
} catch (error) {
  console.log(error.message, error.code, error.lineNumber, error.columnNumber)
}
```

错误代码为 `ERR_INVALID_TYPESCRIPT_SYNTAX`，两个位置字段均为 undefined。只有简短的解析器消息时，模型只能猜测应修改的位置。

## 决策

Node 提供方接受 Stage 1 [TC39 improve-template-literals 提案](https://github.com/tc39/proposal-improve-template-literals)中 `@` 加多个反引号的原始字符串语法。逐次执行与内存保留模式在擦除类型前调用同一个共享预处理器。[包参考](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md#raw-text-literals)定义分隔符匹配、外层优先识别、开头换行删除与逐字内容保留规则。

识别采用外层优先规则，不分析 JavaScript 词法：在尚未进入原始正文的位置，源码任何地方的 ``` @`` ``` 都会开启原始字面量，包括字符串、模板、注释及正则字面量内部。这会保留该开头序列，但识别规则没有歧义，也无需判断正则与除号。普通字符串将 @ 编码为 ``` \x40`` ```；原始正文通过更长的分隔符容纳较短的开头序列。类似地，HTML 切分 `<script>` 时只认 `</script>`，内层 JavaScript 需要时写成 `<\/script>`；heredoc 只检查结束标记；Markdown 用更长的围栏避免冲突。

被省略的开头换行改成生成模板内部的反斜杠续行。因此保留 LF 源码行号，不会在 `return` 与值之间引入行终止符，也不改变成员访问／ASI 行为。内容中的 CR 编码为 `\r`，避免模板换行归一化；不保留孤立 CR 对源码行号的贡献。

类型擦除失败时，仅编译的 `vm.Script` 将预处理源码包装为异步函数表达式，并扣除包装行。REPL 诊断也使用该异步包装，防止合法的顶层 await 遮住后续语法错误。模型代码不会在 Host 中运行。JavaScript 语法错误只附加源码帧与消息，并明确标注含 TypeScript 专有语法时位置为近似值；JavaScript 编译成功则不附加内容。执行 bootstrap 与沙箱保持不变。

## 考虑过的替代方案

**自由格式工具调用或绕过客户端解析。** 观察到的失败不在外层 JSON。Anthropic 的 `tool_use.input` 在服务端解析，因此客户端无法从该接口取回非 JSON 文本载荷。

**为 `run_code` 增加独立 `payloads` 参数。** 它提供相同的文本保留效果，但会改变工具 schema，并让文本离开程序使用它的位置。

**自动修复普通引号字符串中的真实换行。** 有用的位置提示让模型可以在重试时修正源码。静默修复会执行与语言规则所定义的模型源码不同的代码。

**要求使用 `String.raw`。** 它仍需额外的引号处理，才能容纳任意反引号或 `${`。

**恢复原生／PTC 混合呈现。** 上游已移除混合模式；修改呈现方式超出本次语言修复的范围。

**根据 JavaScript token 推断正则字面量。** 用前一个 token 判断 `/` 是否开启正则仍是启发式；`)` 或 `}` 后接正则可能被误判，使内层引号或反引号遮住后续原始开头标记。

**使用完整解析器（例如 `@babel/parser`）逐段解析前缀。** 原始开头标记本身不是合法 JavaScript 语法。每个候选位置都需要解析它前面的前缀，再根据解析错误判断前缀末尾是否处于字符串、注释或正则内部。这依赖诊断文案，还会新增依赖，并不能简化外层优先规则。

## 后果

原始字面量移除一层常见转义，代价是在普通 JavaScript 字符串中也保留 ``` @`` ``` 序列；现有程序文本包含它时，必须编码 @ 或使用更长的原始分隔符。这是 `run_code` 的语言扩展，不是可移植 TypeScript 语法，也不代表 TC39 提案已成为标准。JavaScript 诊断可能先停在 TypeScript 标注而非真正错误处；列号针对转换后的文本。包参考明确保留这些限制。

本功能不修复 shell 层的嵌套引号。嵌入 shell 脚本仍应先写成脚本文件，或使用带引号分隔符的 heredoc 经 stdin 传入。运行时支持不会更新外部提示指导插件；在这些插件中采用原始字面量，并在部署后复查转义类失败，仍是独立后续工作。

原本合法的字符串、模板、注释或正则字面量中含有保留开头标记时，需要调整程序源码。Workflow 的 `script` 正文作为数据通过绑定传递并单独编译，不经过此预处理器，也不支持原始字面量语法。打开／恢复历史会话及渲染已存储结果不会执行旧程序；手动重跑程序及在 recorded-session 测试中重放模型调用，则会按新规则执行。包测试覆盖两种真实进程模式及固定的模型可见诊断。本次没有新增 recorded-session 场景：修改其重放的模型程序需要重新录制，而使用 API key 的录制不在本任务范围内。因此组合后的 transcript（文本记录）覆盖仍是明确缺口。
