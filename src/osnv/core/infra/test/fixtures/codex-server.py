#!/usr/bin/python3
"""Local protocol fixture. Never contacts OpenAI or reads real credentials."""
import json, os, pathlib, sys, threading, time
home = pathlib.Path(os.environ['CODEX_HOME'])
home.mkdir(parents=True, exist_ok=True)
lock = threading.Lock()
config = {}
for i, arg in enumerate(sys.argv):
    if arg == '-c':
        key, raw = sys.argv[i+1].split('=', 1)
        target = config
        keys = key.split('.')
        for part in keys[:-1]: target = target.setdefault(part, {})
        target[keys[-1]] = json.loads(raw)
threads = {}; turns = {}; tool_results = {}; login = None; count = 0; rpc_counts = {}
skill_names = ['imagegen', 'openai-docs', 'plugin-creator', 'review-agent', 'skill-creator', 'skill-installer']
skills = [{'name':name, 'path':str(home/'skills'/'.system'/name/'SKILL.md'), 'scope':'system', 'enabled':True} for name in skill_names]
def skills_mode():
    path = home/'fixture-skills-mode'
    return path.read_text().strip() if path.exists() else ''
def output(value):
    with lock: print(json.dumps(value, ensure_ascii=False), flush=True)
def notification(method, params): output({'method':method,'params':params})
def respond(message, value): output({'id':message['id'],'result':value})
def wire(message):
    with (home/'fixture-wire.jsonl').open('a') as target: target.write(json.dumps(message)+'\n')
def account():
    return {'type':'chatgpt','email':'fixture@example.test','planType':'plus'} if (home/'fixture-account').exists() else None
def complete(thread, turn, status, answer=''):
    notification('turn/completed', {'threadId':thread,'turn':{'id':turn,'status':status,'items':[] if not answer else [{'type':'agentMessage','id':'message-'+turn,'text':answer}]}})
def generate(thread, turn, message, stop):
    if message == 'early': return
    time.sleep(.02)
    answer = 'Ответ: '+message
    if message.startswith('tool'):
        request_id = 'tool-request-'+turn
        received = threading.Event(); tool_results[request_id] = {'event':received}
        declared = threads[thread].get('dynamicTools', [])
        name = declared[0]['name'] if declared else 'missing'
        if message == 'tool-unknown': name = 'not_assigned'
        params = {'threadId':thread,'turnId':turn,'callId':'call-'+turn,'namespace':None,'tool':name,'arguments':{'page':1}}
        if message == 'tool-cross-turn': params['turnId'] = 'different-turn'
        if message == 'tool-namespace': params['namespace'] = 'native'
        notification('item/started', {'threadId':thread,'turnId':turn,'item':{'id':'call-'+turn,'type':'dynamicToolCall','status':'inProgress','tool':name,'arguments':params['arguments']}})
        output({'id':request_id,'method':'item/tool/call','params':params})
        if message == 'tool-early-complete':
            complete(thread,turn,'completed','Unverified completion'); return
        while not received.wait(.01):
            if stop.is_set(): complete(thread,turn,'interrupted'); return
        result = tool_results[request_id].get('result', {})
        if not result.get('success'):
            complete(thread,turn,'failed'); return
        answer = 'Данные: '+result['contentItems'][0]['text']
        if message == 'tool-duplicate':
            output({'id':request_id+'-again','method':'item/tool/call','params':params})
            stop.wait(3); complete(thread,turn,'interrupted'); return
        notification('item/completed', {'threadId':thread,'turnId':turn,'item':{'id':'call-'+turn,'type':'dynamicToolCall','status':'completed','success':True}})
    delta = {'threadId':thread,'turnId':turn,'itemId':'message-'+turn,'delta':answer[:7]}
    notification('item/agentMessage/delta',delta)
    if message == 'dead': os._exit(9)
    if message == 'unsupported':
        output({'id':'approval','method':'item/commandExecution/requestApproval','params':{'threadId':thread,'turnId':turn}})
    if stop.wait(8 if message.startswith('slow') or message == 'unsupported' else .12):
        complete(thread,turn,'interrupted'); return
    if message == 'failure': complete(thread,turn,'failed'); return
    if message == 'large': delta['delta']='x'*33000; notification('item/agentMessage/delta',delta); return
    delta['delta']=answer[7:]; notification('item/agentMessage/delta',delta)
    notification('item/completed', {'threadId':thread,'turnId':turn,'item':{'type':'agentMessage','id':'message-'+turn,'text':answer}})
    complete(thread,turn,'completed',answer)
for line in sys.stdin:
    message=json.loads(line); wire(message)
    method=message.get('method'); params=message.get('params',{})
    if method is None and message.get('id') in tool_results:
        entry=tool_results[message['id']]; entry['result']=message.get('result', {}); entry['event'].set(); continue
    if 'id' not in message or method is None: continue
    rpc_counts[method] = rpc_counts.get(method, 0) + 1
    hold = home/'fixture-hold-rpc'
    if hold.exists():
        target = json.loads(hold.read_text())
        if method == target['method'] and rpc_counts[method] == target.get('occurrence', 1):
            while hold.exists(): time.sleep(.005)
    if method=='initialize': respond(message,{'userAgent':'fixture','codexHome':str(home)})
    elif method=='config/read': respond(message,{'config':config})
    elif method=='skills/list':
        mode = skills_mode()
        items = [dict(skill) for skill in skills]
        if mode == 'new-skill': items.append({'path':str(home/'skills'/'new'/'SKILL.md'), 'enabled':True})
        if mode == 'reenabled': items[0]['enabled'] = True
        if mode == 'duplicate-path': items.append(dict(items[0]))
        if mode == 'bad-enabled': items[0]['enabled'] = 'false'
        if mode == 'relative-path': items[0]['path'] = 'skills/imagegen/SKILL.md'
        if mode == 'too-many': items = [{'path':str(home/'skills'/str(i)/'SKILL.md'), 'enabled':True} for i in range(129)]
        group = {'cwd':'/wrong/workspace' if mode == 'wrong-cwd' else params['cwds'][0], 'skills':items,
            'errors':[{'message':'private-token-should-not-leak'}] if mode == 'discovery-error' else []}
        respond(message, {} if mode == 'missing-data' else {'data':[group]})
    elif method=='skills/config/write':
        mode = skills_mode()
        if mode == 'reject-write': output({'id':message['id'],'error':{'code':-1,'message':'private-token-should-not-leak'}})
        else:
            if mode != 'ignore-write':
                for skill in skills:
                    if skill['path'] == params['path']: skill['enabled'] = params['enabled']
            respond(message, {} if mode == 'bad-write-response' else {'effectiveEnabled':params['enabled']})
    elif method=='account/read':
        if login and (home/'fixture-login-success').exists():
            (home/'fixture-account').touch(); notification('account/login/completed',{'loginId':login,'success':True}); login=None
        respond(message,{'account':account(),'requiresOpenaiAuth':True})
    elif method=='account/login/start':
        login='login-fixture'
        respond(message, {'type':'chatgpt','loginId':login,'authUrl':'https://auth.openai.com/oauth/authorize?fixture=true'} if params['type']=='chatgpt' else {'type':'chatgptDeviceCode','loginId':login,'verificationUrl':'https://auth.openai.com/codex/device','userCode':'FIXT-1234'})
    elif method=='account/login/cancel': login=None; respond(message,{'status':'canceled'})
    elif method=='account/logout':
        (home/'fixture-account').unlink(missing_ok=True); (home/'fixture-login-success').unlink(missing_ok=True); respond(message,{})
    elif method=='model/list':
        def model(id, name, default, efforts):
            return {'model':id,'displayName':name,'isDefault':default,'hidden':False,
                'defaultReasoningEffort':efforts[0], 'supportedReasoningEfforts':[{'reasoningEffort':effort,'description':effort+' reasoning'} for effort in efforts]}
        respond(message,{'data':[model('fixture-model','Fixture model',True,['medium','high','xhigh']),
            model('fixture-fast','Fixture fast',False,['low','high'])], 'nextCursor':None})
    elif method=='thread/start':
        count+=1; thread='thread-'+str(count); threads[thread]=params
        respond(message,{'thread':{'id':thread,'ephemeral':True},'model':params['model'],'modelProvider':'openai','approvalPolicy':'never','sandbox':{'type':'readOnly'}})
    elif method=='turn/start':
        thread=params['threadId']; turn='turn-'+thread; value=json.loads(params['input'][0]['text'])['message']; stop=threading.Event(); turns[turn]=stop
        if value=='early':
            notification('item/agentMessage/delta',{'threadId':thread,'turnId':turn,'itemId':'message-'+turn,'delta':'Ранний ответ'})
            complete(thread,turn,'completed','Ранний ответ')
        respond(message,{'turn':{'id':turn,'status':'inProgress'}})
        threading.Thread(target=generate,args=(thread,turn,value,stop),daemon=True).start()
    elif method=='turn/interrupt':
        turns[params['turnId']].set(); respond(message,{})
    elif method=='thread/unsubscribe': threads.pop(params['threadId'],None); respond(message,{'status':'unsubscribed'})
    elif method=='test/hang': pass
    elif method=='test/bad-result': respond(message,[])
    elif method=='test/malformed': print('{invalid',flush=True)
    elif method=='test/huge': print('x'*1100000,flush=True)
    elif method=='test/invalid-request-id': output({'id':'x'*257,'method':'item/tool/call','params':{}})
    else: output({'id':message['id'],'error':{'code':-1,'message':'private-token-should-not-leak'}})
