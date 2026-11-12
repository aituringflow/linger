/** 附件随本轮消息上传时，只对明确的“长期保存”请求走服务端直存。 */
export function attachmentMemoryIntent(text: string): { save: boolean; saveOnly: boolean; description: string } {
  const request = text.replace(/^\[附件\][^\n]*\n?/gm, "").trim();
  const wantsSave = /记住|记下来|保存|留存|存起来|存档|remember|keep\s+(?:this|it|file)/i.test(request);
  const refusesSave = /(?:不要|别|无需|不用|不必|禁止|先别|暂不|不用帮我|无需帮我).{0,6}(?:记住|记下来|保存|留存|存起来|存档)|(?:do\s+not|don't|never)\s+(?:remember|save|keep)/i.test(request);
  const save = wantsSave && !refusesSave;
  const needsOtherWork = /总结|概括|分析|提取|读取|查看|看看|修改|转换|翻译|发给|发送|生成|制作|写一份|回答|比较|对比|解释|提炼|审阅|评价/i.test(request);
  return { save, saveOnly: save && !needsOtherWork, description: request };
}
