import { useState, useEffect, useRef, useCallback } from "react";

const TOTAL = 90;
const ROW_COLORS = ["#e84545","#e8824a","#d4b84a","#7bc67b","#4ab8a0","#4aaee8","#6b7ae8","#a06be8","#e06bb5","#a0a0b8"];
const DIGIT_WORDS = ["zero","one","two","three","four","five","six","seven","eight","nine"];
const PRIZES = [
  { key:"early5", label:"Early Five",  color:"#4aaee8", desc:"First 5 numbers called on ticket" },
  { key:"row1",   label:"Top Line",    color:"#e84545", desc:"All 5 numbers in the top row" },
  { key:"row2",   label:"Middle Line", color:"#e8824a", desc:"All 5 numbers in the middle row" },
  { key:"row3",   label:"Bottom Line", color:"#d4b84a", desc:"All 5 numbers in the bottom row" },
  { key:"full",   label:"Full House",  color:"#f0a830", desc:"All 15 numbers on the ticket" },
];

function getCallName(n) {
  const names = {1:"Kelly's Eye",2:"One and Two",3:"Cup of Tea",4:"Knock at the Door",5:"Man Alive",6:"Half a Dozen",7:"Lucky Seven",8:"Garden Gate",9:"Doctor's Orders",10:"Prime Minister's Den",11:"Legs Eleven",13:"Unlucky Thirteen",16:"Sweet Sixteen",21:"Key of the Door",22:"Two Little Ducks",25:"Duck and Dive",30:"Dirty Gertie",33:"Dirty Knees",40:"Life Begins",44:"Droopy Drawers",45:"Halfway There",50:"Half a Century",55:"Snakes Alive",60:"Five Dozen",66:"Clickety Click",69:"Same Both Ways",76:"Trombones",77:"Sunset Strip",88:"Two Fat Ladies",90:"Top of the Shop"};
  return names[n] || "";
}

function speakSequence(phrases, onDone) {
  if (!window.speechSynthesis) { onDone?.(); return; }
  window.speechSynthesis.cancel();
  const voices = window.speechSynthesis.getVoices();
  const pref = voices.find(v => v.lang.startsWith("en") && (v.name.includes("Google")||v.name.includes("Samantha")||v.name.includes("Karen"))) || voices.find(v => v.lang.startsWith("en"));
  let idx = 0;
  const next = () => {
    if (idx >= phrases.length) { onDone?.(); return; }
    const { text, rate=0.85, pause=0 } = phrases[idx++];
    setTimeout(() => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate; u.pitch = 1.05; u.volume = 1;
      if (pref) u.voice = pref;
      u.onend = next; u.onerror = next;
      window.speechSynthesis.speak(u);
    }, pause);
  };
  next();
}
function announceNumber(num, onDone) {
  const name = getCallName(num), phrases = [];
  if (num >= 10) {
    phrases.push({ text:`${DIGIT_WORDS[Math.floor(num/10)]} ${DIGIT_WORDS[num%10]}`, rate:0.8 });
    phrases.push({ text:String(num), rate:0.82, pause:200 });
  } else phrases.push({ text:String(num), rate:0.82 });
  if (name) phrases.push({ text:name, rate:0.88, pause:240 });
  speakSequence(phrases, onDone);
}
function speakSimple(t) { speakSequence([{text:t,rate:0.9}]); }

async function scanTicketImage(base64, mediaType) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:400,
      messages:[{ role:"user", content:[
        { type:"image", source:{ type:"base64", media_type:mediaType, data:base64 }},
        { type:"text", text:'This is a Tambola/Housie lottery ticket. It has 3 rows. Each row has exactly 5 numbers (between 1 and 90) and blank spaces.\n\nExtract the numbers row by row. Return ONLY valid JSON, no markdown, no explanation:\n{"row1":[n,n,n,n,n],"row2":[n,n,n,n,n],"row3":[n,n,n,n,n]}\n\nEach array must have exactly 5 integers.' }
      ]}]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.find(b=>b.type==="text")?.text || "";
  const parsed = JSON.parse(text.replace(/```json?|```/g,"").trim());
  return [parsed.row1, parsed.row2, parsed.row3];
}

function callPos(called, n) {
  const i = called.indexOf(n);
  return i === -1 ? Infinity : called.length - 1 - i; // 0 = first called
}

function computeResults(tickets, called) {
  return PRIZES.map(prize => {
    const rankings = tickets.map(ticket => {
      const flat = ticket.rows.flat();
      let prizeNums, completedAt, needed;
      if (prize.key === "early5") {
        const calledSorted = flat.filter(n => callPos(called,n) < Infinity).sort((a,b) => callPos(called,a)-callPos(called,b));
        if (calledSorted.length < 5) { needed = 5 - calledSorted.length; completedAt = Infinity; }
        else { prizeNums = calledSorted.slice(0,5); needed = 0; completedAt = Math.max(...prizeNums.map(n=>callPos(called,n))); }
      } else {
        prizeNums = prize.key==="row1" ? ticket.rows[0] : prize.key==="row2" ? ticket.rows[1] : prize.key==="row3" ? ticket.rows[2] : flat;
        needed = prizeNums.filter(n => callPos(called,n)===Infinity).length;
        completedAt = needed === 0 ? Math.max(...prizeNums.map(n=>callPos(called,n))) : Infinity;
      }
      return { ...ticket, completedAt, needed };
    }).sort((a,b) => {
      if (a.completedAt===Infinity && b.completedAt===Infinity) return a.needed - b.needed;
      if (a.completedAt===Infinity) return 1;
      if (b.completedAt===Infinity) return -1;
      return a.completedAt - b.completedAt;
    });
    return { ...prize, rankings };
  });
}

const EMPTY_ROWS = () => [["","","","",""],["","","","",""],["","","","",""]];

export default function Tambola() {
  // ── Game state
  const [called,    setCalled]    = useState([]);
  const [current,   setCurrent]   = useState(null);
  const [remaining, setRemaining] = useState(()=>Array.from({length:TOTAL},(_,i)=>i+1));
  const [animating, setAnimating] = useState(false);
  const [flash,     setFlash]     = useState(false);
  const [autoPlay,  setAutoPlay]  = useState(false);
  const [voiceOn,   setVoiceOn]   = useState(true);
  const [countdown, setCountdown] = useState(null);
  // ── Nav
  const [view, setView] = useState("game");
  // ── Tickets
  const [tickets,   setTickets]   = useState([]);
  const [addState,  setAddState]  = useState(null); // null|"choose"|"scanning"|"manual"|"editing"
  const [newName,   setNewName]   = useState("");
  const [newRows,   setNewRows]   = useState(EMPTY_ROWS);
  const [scanStatus,setScanStatus]= useState(null); // null|"loading"|"error"
  const [scanError, setScanError] = useState("");

  const spinRef=useRef(null), cdRef=useRef(null);
  const remainingRef=useRef(remaining), animatingRef=useRef(false), autoPlayRef=useRef(false), voiceOnRef=useRef(true);
  remainingRef.current=remaining; animatingRef.current=animating; autoPlayRef.current=autoPlay; voiceOnRef.current=voiceOn;

  useEffect(()=>{
    window.speechSynthesis?.getVoices();
    const h=()=>window.speechSynthesis?.getVoices();
    window.speechSynthesis?.addEventListener?.("voiceschanged",h);
    return ()=>window.speechSynthesis?.removeEventListener?.("voiceschanged",h);
  },[]);

  const scheduleNext = useCallback(()=>{
    if (!autoPlayRef.current||!remainingRef.current.length) return;
    clearInterval(cdRef.current);
    let ticks=3; setCountdown((ticks*0.5).toFixed(1));
    cdRef.current=setInterval(()=>{
      ticks-=1;
      if(ticks<=0){clearInterval(cdRef.current);setCountdown(null);if(autoPlayRef.current)doCall();}
      else setCountdown((ticks*0.5).toFixed(1));
    },500);
  },[]);

  const doCall = useCallback(()=>{
    if(animatingRef.current||!remainingRef.current.length) return;
    clearInterval(cdRef.current); setCountdown(null); setAnimating(true); setFlash(false);
    let ticks=0; const pool=[...remainingRef.current];
    spinRef.current=setInterval(()=>{
      setCurrent(pool[Math.floor(Math.random()*pool.length)]);
      if(++ticks>=12){
        clearInterval(spinRef.current);
        const snap=remainingRef.current; if(!snap.length){setAnimating(false);return;}
        const i=Math.floor(Math.random()*snap.length); const num=snap[i];
        setCurrent(num); setRemaining(p=>p.filter(n=>n!==num)); setCalled(p=>[num,...p]);
        setAnimating(false); setFlash(true); setTimeout(()=>setFlash(false),800);
        if(voiceOnRef.current) announceNumber(num,()=>{if(autoPlayRef.current)scheduleNext();});
        else if(autoPlayRef.current) scheduleNext();
      }
    },55);
  },[scheduleNext]);

  useEffect(()=>{
    if(autoPlay){if(!remaining.length){setAutoPlay(false);return;}if(!animating)doCall();}
    else{clearInterval(cdRef.current);setCountdown(null);window.speechSynthesis?.cancel();}
    return ()=>clearInterval(cdRef.current);
  },[autoPlay]);

  const resetGame = ()=>{
    clearInterval(spinRef.current); clearInterval(cdRef.current); window.speechSynthesis?.cancel();
    setCalled([]); setCurrent(null); setRemaining(Array.from({length:TOTAL},(_,i)=>i+1));
    setAnimating(false); setFlash(false); setAutoPlay(false); setCountdown(null);
  };
  useEffect(()=>()=>{clearInterval(spinRef.current);clearInterval(cdRef.current);},[]);

  // ── Ticket handlers
  const updateRow=(ri,ci,val)=>setNewRows(prev=>{const r=prev.map(row=>[...row]);r[ri][ci]=val;return r;});
  const deleteTicket=id=>setTickets(prev=>prev.filter(t=>t.id!==id));
  const cancelAdd=()=>{setAddState(null);setNewName("");setNewRows(EMPTY_ROWS());setScanStatus(null);setScanError("");};

  const handleScanUpload = async e => {
    const file = e.target.files[0]; if(!file) return;
    setScanStatus("loading"); setScanError("");
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        const base64 = ev.target.result.split(",")[1];
        const mediaType = file.type||"image/jpeg";
        const rows = await scanTicketImage(base64, mediaType);
        if(!rows||rows.length!==3||rows.some(r=>!Array.isArray(r)||r.length!==5)) throw new Error("Couldn't read 3 rows of 5 numbers");
        setNewRows(rows.map(r=>r.map(String)));
        setAddState("editing"); setScanStatus(null);
      } catch(err) {
        setScanStatus("error"); setScanError(err.message||"Could not read ticket");
      }
    };
    reader.readAsDataURL(file);
  };

  const saveTicket = () => {
    if(!newName.trim()){alert("Enter player name");return;}
    const rows = newRows.map(row=>row.map(n=>parseInt(n)));
    const flat = rows.flat();
    if(flat.some(n=>isNaN(n)||n<1||n>90)){alert("All 15 numbers must be between 1 and 90");return;}
    if(new Set(flat).size!==15){alert("Ticket must have 15 unique numbers");return;}
    setTickets(prev=>[...prev,{id:Date.now(),playerName:newName.trim(),rows}]);
    cancelAdd();
  };

  const rows9x10 = Array.from({length:9},(_,r)=>Array.from({length:10},(_,c)=>r*10+c+1));
  const pct = Math.round(called.length/TOTAL*100);
  const done = remaining.length===0;
  const callName = current?getCallName(current):"";
  const results = computeResults(tickets, called);

  const S = {
    outer:{ height:"100dvh",width:"100dvw",overflow:"hidden",background:"linear-gradient(160deg,#110228 0%,#1e0840 55%,#0a1535 100%)",display:"flex",flexDirection:"column",fontFamily:"'Georgia',serif",color:"#fff",boxSizing:"border-box",WebkitUserSelect:"none",userSelect:"none",touchAction:"manipulation" },
    tabBar:{ display:"flex",flexShrink:0,background:"rgba(0,0,0,0.45)",borderTop:"1px solid rgba(255,255,255,0.08)" },
  };

  const Tab=({id,label,icon,badge})=>(
    <button onClick={()=>setView(id)} style={{
      flex:1,padding:"10px 0",border:"none",background:"transparent",
      color:view===id?"#f0a830":"rgba(255,255,255,0.4)",
      fontSize:"clamp(10px,1.8vw,13px)",fontFamily:"inherit",cursor:"pointer",
      borderTop:view===id?"2px solid #f0a830":"2px solid transparent",
      transition:"all 0.2s",display:"flex",flexDirection:"column",alignItems:"center",gap:"2px"
    }}>
      <span style={{fontSize:"clamp(16px,3vw,22px)"}}>{icon}</span>
      <span style={{letterSpacing:"0.5px",textTransform:"uppercase"}}>{label}</span>
      {badge>0&&<span style={{position:"absolute",top:"8px",background:"#e84545",color:"#fff",fontSize:"10px",borderRadius:"10px",padding:"1px 5px",fontWeight:700}}>{badge}</span>}
    </button>
  );

  // ─────────────────────────────────────────────────────────────
  // GAME VIEW
  // ─────────────────────────────────────────────────────────────
  const gameView = (
    <div style={{flex:1,minHeight:0,display:"flex",flexDirection:"column",padding:"8px 8px 4px",gap:"6px"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"baseline",gap:"8px"}}>
          <span style={{fontSize:"clamp(20px,4vw,32px)",fontWeight:900,background:"linear-gradient(90deg,#f0a830,#ff6b35)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",letterSpacing:"2px"}}>TAMBOLA</span>
          <span style={{fontSize:"clamp(8px,1.5vw,11px)",letterSpacing:"3px",color:"#f0a83066",textTransform:"uppercase"}}>Housie</span>
        </div>
        <div style={{display:"flex",gap:"6px",alignItems:"center"}}>
          <div style={{background:"rgba(255,255,255,0.07)",borderRadius:"20px",padding:"4px 12px",fontSize:"clamp(11px,1.8vw,14px)",border:"1px solid rgba(255,255,255,0.1)"}}>
            <span style={{color:"#f0a830",fontWeight:700}}>{called.length}</span>
            <span style={{color:"rgba(255,255,255,0.35)"}}> / {TOTAL}</span>
          </div>
          <button onClick={resetGame} style={{background:"transparent",border:"1px solid rgba(255,255,255,0.2)",color:"rgba(255,255,255,0.5)",padding:"5px 10px",borderRadius:"20px",cursor:"pointer",fontSize:"clamp(10px,1.5vw,12px)",fontFamily:"inherit"}}>↺</button>
        </div>
      </div>

      {/* Info strip */}
      <div style={{display:"flex",gap:"8px",flexShrink:0,height:"clamp(100px,18vh,155px)"}}>
        {/* Circle */}
        <div style={{flexShrink:0,width:"clamp(95px,18vh,150px)",height:"100%",borderRadius:"50%",background:flash?"radial-gradient(circle,#f0a830,#ff6b35)":"radial-gradient(circle,#2a1060,#140830)",border:`3px solid ${flash?"#fff":"#f0a830"}`,boxShadow:flash?"0 0 40px #f0a830":"0 0 20px rgba(240,168,48,0.2)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",transition:"all 0.15s",position:"relative"}}>
          {countdown!==null&&<div style={{position:"absolute",inset:"-6px",borderRadius:"50%",border:"3px solid transparent",borderTopColor:"#4aaee8",animation:"spin 1s linear infinite",pointerEvents:"none"}}/>}
          {current?<>
            <div style={{fontSize:"clamp(44px,10vh,80px)",fontWeight:900,lineHeight:1,color:flash?"#1a0533":"#f0a830",transition:"color 0.15s"}}>{current}</div>
            {callName&&<div style={{fontSize:"clamp(7px,1.2vh,10px)",color:flash?"#1a053388":"#f0a83088",marginTop:"2px",textAlign:"center",padding:"0 6px",textTransform:"uppercase",lineHeight:1.2}}>{callName}</div>}
          </>:<div style={{color:"#f0a83033",fontSize:"12px",letterSpacing:"2px"}}>{remaining.length===TOTAL?"READY":"DONE"}</div>}
        </div>
        {/* Recent */}
        <div style={{flex:1,minWidth:0,background:"rgba(0,0,0,0.25)",borderRadius:"14px",padding:"8px 10px",border:"1px solid rgba(255,255,255,0.07)",display:"flex",flexDirection:"column"}}>
          <div style={{fontSize:"clamp(8px,1.4vw,10px)",letterSpacing:"3px",color:countdown!==null?"#4aaee8":"#f0a83066",textTransform:"uppercase",marginBottom:"6px",flexShrink:0}}>
            {countdown!==null?`Next in ${countdown}s…`:"Recently Called"}
          </div>
          {called.length===0?<div style={{color:"rgba(255,255,255,0.15)",fontSize:"12px",display:"flex",alignItems:"center",flex:1}}>No numbers called yet</div>:(
            <div style={{display:"flex",flexWrap:"wrap",gap:"5px",alignContent:"flex-start",overflow:"hidden",flex:1}}>
              {called.slice(0,16).map((n,i)=>(
                <div key={n} style={{width:i===0?"clamp(38px,7vh,52px)":"clamp(28px,5vh,40px)",height:i===0?"clamp(38px,7vh,52px)":"clamp(28px,5vh,40px)",borderRadius:"50%",flexShrink:0,background:i===0?"linear-gradient(135deg,#f0a830,#ff6b35)":`rgba(255,255,255,${Math.max(0.06,0.17-i*0.01)})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:i===0?"clamp(14px,3vh,20px)":"clamp(10px,2vh,15px)",fontWeight:700,color:i===0?"#1a0533":"rgba(255,255,255,0.8)",border:i===0?"none":"1px solid rgba(255,255,255,0.12)"}}>
                  {n}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Grid */}
      <div style={{flex:1,minHeight:0,background:"rgba(0,0,0,0.28)",borderRadius:"14px",padding:"6px",border:"1px solid rgba(240,168,48,0.1)",display:"flex",flexDirection:"column",gap:"3px"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(10,1fr)",gap:"3px",flexShrink:0}}>
          {[1,2,3,4,5,6,7,8,9,10].map(c=><div key={c} style={{textAlign:"center",fontSize:"clamp(7px,1.2vw,11px)",color:"rgba(255,255,255,0.22)",fontWeight:600}}>×{c}</div>)}
        </div>
        {rows9x10.map((row,ri)=>(
          <div key={ri} style={{display:"grid",gridTemplateColumns:"repeat(10,1fr)",gap:"3px",flex:1,minHeight:0}}>
            {row.map(num=>{
              const isCalled=called.includes(num), isCurrent=current===num;
              return <div key={num} style={{borderRadius:"6px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:isCalled?"clamp(11px,2vw,18px)":"clamp(10px,1.7vw,16px)",fontWeight:isCalled?900:400,background:isCurrent&&flash?"#f0a830":isCalled?ROW_COLORS[ri]:"rgba(255,255,255,0.04)",color:isCurrent&&flash?"#1a0533":isCalled?"#fff":"rgba(255,255,255,0.2)",border:isCurrent?"2px solid #f0a830":isCalled?"none":"1px solid rgba(255,255,255,0.06)",boxShadow:isCurrent?"0 0 12px rgba(240,168,48,0.7)":isCalled?"inset 0 -2px 0 rgba(0,0,0,0.2)":"none",textShadow:isCalled&&!isCurrent?"0 1px 3px rgba(0,0,0,0.5)":"none",transform:isCurrent&&flash?"scale(1.08)":"scale(1)",transition:"all 0.2s",minHeight:0}}>{num}</div>;
            })}
          </div>
        ))}
      </div>

      {/* Controls */}
      <div style={{display:"flex",gap:"6px",flexShrink:0}}>
        <button onClick={doCall} disabled={done||animating||autoPlay} style={{flex:2,padding:"clamp(10px,2vh,14px) 0",fontSize:"clamp(12px,2vw,16px)",fontWeight:700,letterSpacing:"1px",border:"none",borderRadius:"50px",fontFamily:"inherit",textTransform:"uppercase",cursor:(done||animating||autoPlay)?"not-allowed":"pointer",background:done?"#333":animating?"linear-gradient(90deg,#ff6b35,#f0a830)":autoPlay?"#222":"linear-gradient(90deg,#f0a830,#ff6b35)",color:(done||autoPlay)?"#555":"#1a0533",boxShadow:(!done&&!autoPlay)?"0 3px 14px rgba(240,168,48,0.35)":"none",transition:"all 0.2s"}}>
          {done?"All Done!":animating?"Calling…":"Call Number"}
        </button>
        <button onClick={()=>{if(!done)setAutoPlay(p=>!p);}} disabled={done} style={{flex:1.5,padding:"clamp(10px,2vh,14px) 0",fontSize:"clamp(12px,2vw,15px)",fontWeight:700,border:"2px solid",borderRadius:"50px",fontFamily:"inherit",textTransform:"uppercase",cursor:done?"not-allowed":"pointer",borderColor:autoPlay?"#4aaee8":"rgba(74,174,232,0.4)",background:autoPlay?"rgba(74,174,232,0.15)":"transparent",color:autoPlay?"#4aaee8":"rgba(74,174,232,0.55)",transition:"all 0.2s",display:"flex",alignItems:"center",justifyContent:"center",gap:"5px"}}>
          <span>{autoPlay?"⏸":"▶"}</span><span>{autoPlay?"Pause":"Auto"}</span>
        </button>
        <button onClick={()=>{const n=!voiceOn;setVoiceOn(n);if(!n)window.speechSynthesis?.cancel();else speakSimple("Voice on");}} style={{flex:1,padding:"clamp(10px,2vh,14px) 0",fontSize:"clamp(16px,3vw,22px)",border:"1px solid",borderRadius:"50px",fontFamily:"inherit",cursor:"pointer",borderColor:voiceOn?"#7bc67b":"rgba(123,198,123,0.3)",background:voiceOn?"rgba(123,198,123,0.1)":"transparent",transition:"all 0.2s"}}>
          {voiceOn?"🔊":"🔇"}
        </button>
      </div>
    </div>
  );

  // ─────────────────────────────────────────────────────────────
  // TICKETS VIEW
  // ─────────────────────────────────────────────────────────────
  const ticketsView = (
    <div style={{flex:1,minHeight:0,overflow:"auto",padding:"12px 10px"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"14px",flexShrink:0}}>
        <div>
          <div style={{fontSize:"clamp(18px,3vw,24px)",fontWeight:900,color:"#f0a830"}}>🎫 Tickets</div>
          <div style={{fontSize:"11px",color:"rgba(255,255,255,0.35)",marginTop:"2px"}}>{tickets.length} player{tickets.length!==1?"s":""} added</div>
        </div>
        {addState===null&&<button onClick={()=>setAddState("choose")} style={{background:"linear-gradient(90deg,#f0a830,#ff6b35)",border:"none",color:"#1a0533",padding:"10px 18px",borderRadius:"50px",fontSize:"14px",fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Add Ticket</button>}
      </div>

      {/* Add Ticket Form */}
      {addState!==null&&(
        <div style={{background:"rgba(0,0,0,0.35)",borderRadius:"16px",padding:"16px",border:"1px solid rgba(240,168,48,0.2)",marginBottom:"16px"}}>
          <div style={{fontWeight:700,fontSize:"16px",color:"#f0a830",marginBottom:"12px"}}>
            {addState==="editing"?"Review & Confirm":"Add New Ticket"}
          </div>

          {/* Player name */}
          <input value={newName} onChange={e=>setNewName(e.target.value)}
            placeholder="Player name…"
            style={{width:"100%",boxSizing:"border-box",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:"10px",padding:"10px 14px",color:"#fff",fontSize:"15px",fontFamily:"inherit",outline:"none",marginBottom:"12px"}}/>

          {/* Choose method */}
          {addState==="choose"&&(
            <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
              <div style={{fontSize:"12px",color:"rgba(255,255,255,0.4)",marginBottom:"4px",letterSpacing:"1px",textTransform:"uppercase"}}>How would you like to add the ticket?</div>
              <label style={{display:"flex",alignItems:"center",gap:"10px",background:"rgba(74,174,232,0.1)",border:"1px solid rgba(74,174,232,0.3)",borderRadius:"12px",padding:"12px 14px",cursor:"pointer"}}>
                <span style={{fontSize:"22px"}}>📷</span>
                <div>
                  <div style={{fontWeight:700,color:"#4aaee8",fontSize:"14px"}}>Scan Ticket Photo</div>
                  <div style={{fontSize:"11px",color:"rgba(255,255,255,0.4)"}}>AI reads numbers from image</div>
                </div>
                <input type="file" accept="image/*" capture="environment" onChange={e=>{setAddState("scanning");handleScanUpload(e);}} style={{display:"none"}}/>
              </label>
              <button onClick={()=>{setAddState("manual");setNewRows(EMPTY_ROWS());}} style={{display:"flex",alignItems:"center",gap:"10px",background:"rgba(123,198,123,0.1)",border:"1px solid rgba(123,198,123,0.3)",borderRadius:"12px",padding:"12px 14px",cursor:"pointer",textAlign:"left",fontFamily:"inherit",color:"#fff",width:"100%"}}>
                <span style={{fontSize:"22px"}}>✏️</span>
                <div>
                  <div style={{fontWeight:700,color:"#7bc67b",fontSize:"14px"}}>Enter Manually</div>
                  <div style={{fontSize:"11px",color:"rgba(255,255,255,0.4)"}}>Type in the 15 numbers yourself</div>
                </div>
              </button>
              <button onClick={cancelAdd} style={{background:"transparent",border:"none",color:"rgba(255,255,255,0.3)",padding:"8px",cursor:"pointer",fontFamily:"inherit",fontSize:"13px"}}>✕ Cancel</button>
            </div>
          )}

          {/* Scanning status */}
          {addState==="scanning"&&(
            <div style={{textAlign:"center",padding:"20px 0"}}>
              {scanStatus==="loading"&&<>
                <div style={{fontSize:"32px",marginBottom:"8px",animation:"spin 1.5s linear infinite",display:"inline-block"}}>🔍</div>
                <div style={{color:"#4aaee8",fontSize:"14px"}}>Reading your ticket…</div>
              </>}
              {scanStatus==="error"&&<>
                <div style={{fontSize:"28px",marginBottom:"8px"}}>❌</div>
                <div style={{color:"#e84545",fontSize:"14px",marginBottom:"12px"}}>{scanError}</div>
                <div style={{display:"flex",gap:"8px",justifyContent:"center"}}>
                  <button onClick={()=>{setAddState("manual");setNewRows(EMPTY_ROWS());setScanStatus(null);}} style={{background:"rgba(123,198,123,0.15)",border:"1px solid #7bc67b",color:"#7bc67b",padding:"8px 14px",borderRadius:"50px",cursor:"pointer",fontFamily:"inherit",fontSize:"13px"}}>Enter Manually</button>
                  <button onClick={cancelAdd} style={{background:"transparent",border:"1px solid rgba(255,255,255,0.2)",color:"rgba(255,255,255,0.4)",padding:"8px 14px",borderRadius:"50px",cursor:"pointer",fontFamily:"inherit",fontSize:"13px"}}>Cancel</button>
                </div>
              </>}
            </div>
          )}

          {/* Row editor (manual or post-scan) */}
          {(addState==="manual"||addState==="editing")&&(
            <div>
              <div style={{fontSize:"11px",color:"rgba(255,255,255,0.4)",marginBottom:"10px",letterSpacing:"1px",textTransform:"uppercase"}}>
                {addState==="editing"?"Review scanned numbers — tap any number to edit":"Enter 5 numbers per row (1–90)"}
              </div>
              {[0,1,2].map(ri=>(
                <div key={ri} style={{marginBottom:"10px"}}>
                  <div style={{fontSize:"11px",color:["#e84545","#e8824a","#d4b84a"][ri],letterSpacing:"2px",textTransform:"uppercase",marginBottom:"5px"}}>
                    {["Top","Middle","Bottom"][ri]} Row
                  </div>
                  <div style={{display:"flex",gap:"6px"}}>
                    {[0,1,2,3,4].map(ci=>(
                      <input key={ci} type="number" min="1" max="90"
                        value={newRows[ri][ci]}
                        onChange={e=>updateRow(ri,ci,e.target.value)}
                        style={{width:"100%",flex:1,background:"rgba(255,255,255,0.1)",border:`1px solid ${newRows[ri][ci]&&(parseInt(newRows[ri][ci])<1||parseInt(newRows[ri][ci])>90)?"#e84545":"rgba(255,255,255,0.2)"}`,borderRadius:"8px",padding:"8px 4px",color:"#fff",fontSize:"clamp(14px,3vw,18px)",fontWeight:700,textAlign:"center",fontFamily:"inherit",outline:"none"}}/>
                    ))}
                  </div>
                </div>
              ))}
              <div style={{display:"flex",gap:"8px",marginTop:"14px"}}>
                <button onClick={()=>setAddState("choose")} style={{flex:1,padding:"11px",background:"transparent",border:"1px solid rgba(255,255,255,0.2)",color:"rgba(255,255,255,0.5)",borderRadius:"50px",cursor:"pointer",fontFamily:"inherit",fontSize:"13px"}}>← Back</button>
                <button onClick={saveTicket} style={{flex:2,padding:"11px",background:"linear-gradient(90deg,#f0a830,#ff6b35)",border:"none",color:"#1a0533",borderRadius:"50px",cursor:"pointer",fontFamily:"inherit",fontSize:"14px",fontWeight:700}}>✓ Save Ticket</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Ticket list */}
      {tickets.length===0&&addState===null&&(
        <div style={{textAlign:"center",padding:"40px 20px",color:"rgba(255,255,255,0.25)"}}>
          <div style={{fontSize:"48px",marginBottom:"12px"}}>🎫</div>
          <div style={{fontSize:"15px",marginBottom:"6px"}}>No tickets added yet</div>
          <div style={{fontSize:"12px"}}>Add player tickets to track prize winners</div>
        </div>
      )}
      <div style={{display:"flex",flexDirection:"column",gap:"10px"}}>
        {tickets.map((t,ti)=>(
          <div key={t.id} style={{background:"rgba(255,255,255,0.05)",borderRadius:"14px",padding:"12px 14px",border:"1px solid rgba(255,255,255,0.1)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"10px"}}>
              <div>
                <span style={{fontWeight:700,fontSize:"16px",color:"#f0a830"}}>{t.playerName}</span>
                <span style={{fontSize:"11px",color:"rgba(255,255,255,0.35)",marginLeft:"8px"}}>Ticket #{ti+1}</span>
              </div>
              <button onClick={()=>deleteTicket(t.id)} style={{background:"transparent",border:"1px solid rgba(232,69,69,0.3)",color:"#e84545",padding:"4px 10px",borderRadius:"20px",cursor:"pointer",fontSize:"12px",fontFamily:"inherit"}}>✕</button>
            </div>
            {t.rows.map((row,ri)=>(
              <div key={ri} style={{display:"flex",gap:"5px",marginBottom:"5px"}}>
                <div style={{width:"10px",background:ROW_COLORS[ri],borderRadius:"2px",flexShrink:0}}/>
                <div style={{display:"flex",gap:"4px",flex:1}}>
                  {row.map((n,ci)=>{
                    const isCalled=called.includes(n);
                    return <div key={ci} style={{flex:1,textAlign:"center",padding:"5px 2px",borderRadius:"6px",fontSize:"clamp(11px,2.5vw,14px)",fontWeight:700,background:isCalled?ROW_COLORS[ri]:"rgba(255,255,255,0.06)",color:isCalled?"#fff":"rgba(255,255,255,0.5)",border:isCalled?"none":"1px solid rgba(255,255,255,0.08)",textDecoration:isCalled?"line-through":"none"}}>{n}</div>;
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );

  // ─────────────────────────────────────────────────────────────
  // RESULTS VIEW
  // ─────────────────────────────────────────────────────────────
  const resultsView = (
    <div style={{flex:1,minHeight:0,overflow:"auto",padding:"12px 10px"}}>
      <div style={{marginBottom:"14px"}}>
        <div style={{fontSize:"clamp(18px,3vw,24px)",fontWeight:900,color:"#f0a830"}}>🏆 Prize Results</div>
        <div style={{fontSize:"11px",color:"rgba(255,255,255,0.35)",marginTop:"2px"}}>
          {called.length===0?"Start calling numbers to see results":`Based on ${called.length} numbers called — ${tickets.length} ticket${tickets.length!==1?"s":""}`}
        </div>
      </div>

      {tickets.length===0?(
        <div style={{textAlign:"center",padding:"40px 20px",color:"rgba(255,255,255,0.25)"}}>
          <div style={{fontSize:"48px",marginBottom:"12px"}}>📋</div>
          <div style={{fontSize:"15px",marginBottom:"6px"}}>No tickets to compare</div>
          <div style={{fontSize:"12px"}}>Add player tickets in the Tickets tab first</div>
        </div>
      ):(
        <div style={{display:"flex",flexDirection:"column",gap:"12px"}}>
          {results.map(prize=>{
            const winners = prize.rankings.filter(r=>r.completedAt!==Infinity);
            const pending = prize.rankings.filter(r=>r.completedAt===Infinity);
            return (
              <div key={prize.key} style={{background:"rgba(0,0,0,0.3)",borderRadius:"16px",overflow:"hidden",border:`1px solid ${prize.color}33`}}>
                {/* Prize header */}
                <div style={{background:`${prize.color}22`,borderBottom:`1px solid ${prize.color}33`,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontWeight:900,fontSize:"16px",color:prize.color}}>{prize.label}</div>
                    <div style={{fontSize:"11px",color:"rgba(255,255,255,0.4)",marginTop:"1px"}}>{prize.desc}</div>
                  </div>
                  <div style={{background:`${prize.color}33`,borderRadius:"20px",padding:"3px 10px",fontSize:"12px",fontWeight:700,color:prize.color}}>
                    {winners.length} won
                  </div>
                </div>
                {/* Rankings */}
                <div style={{padding:"10px 14px",display:"flex",flexDirection:"column",gap:"6px"}}>
                  {prize.rankings.map((r,rank)=>{
                    const won = r.completedAt!==Infinity;
                    const medals = ["🥇","🥈","🥉"];
                    return (
                      <div key={r.id} style={{display:"flex",alignItems:"center",gap:"10px",padding:"8px 10px",background:won?`${prize.color}15`:"rgba(255,255,255,0.03)",borderRadius:"10px",border:won?`1px solid ${prize.color}30`:"1px solid rgba(255,255,255,0.06)"}}>
                        <span style={{fontSize:"18px",width:"24px",textAlign:"center",flexShrink:0}}>{won&&rank<3?medals[rank]:won?"✓":""}</span>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontWeight:700,fontSize:"14px",color:won?"#fff":"rgba(255,255,255,0.45)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.playerName}</div>
                          {won?(
                            <div style={{fontSize:"11px",color:prize.color,marginTop:"1px"}}>Won on call #{r.completedAt+1}</div>
                          ):(
                            <div style={{fontSize:"11px",color:"rgba(255,255,255,0.3)",marginTop:"1px"}}>Needs {r.needed} more number{r.needed!==1?"s":""}</div>
                          )}
                        </div>
                        {/* Mini progress */}
                        {!won&&(
                          <div style={{flexShrink:0,width:"48px"}}>
                            <div style={{height:"4px",background:"rgba(255,255,255,0.08)",borderRadius:"2px",overflow:"hidden"}}>
                              <div style={{height:"100%",background:prize.color,borderRadius:"2px",width:`${Math.round(((prize.key==="early5"?5:5)-r.needed)/(prize.key==="full"?15:5)*100)}%`}}/>
                            </div>
                            <div style={{fontSize:"10px",color:"rgba(255,255,255,0.25)",textAlign:"center",marginTop:"2px"}}>{prize.key==="full"?15-r.needed:5-r.needed}/{prize.key==="full"?15:5}</div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div style={S.outer}>
      {/* Content */}
      <div style={{flex:1,minHeight:0,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {view==="game"   && gameView}
        {view==="tickets"&& ticketsView}
        {view==="results"&& resultsView}
      </div>
      {/* Tab bar */}
      <div style={S.tabBar}>
        <Tab id="game"    icon="🎱" label="Game"/>
        <Tab id="tickets" icon="🎫" label="Tickets"/>
        <Tab id="results" icon="🏆" label="Results"/>
      </div>
      <style>{`
        @keyframes spin { to { transform:rotate(360deg); } }
        * { -webkit-tap-highlight-color:transparent; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; }
        input::placeholder { color:rgba(255,255,255,0.25); }
      `}</style>
    </div>
  );
}
