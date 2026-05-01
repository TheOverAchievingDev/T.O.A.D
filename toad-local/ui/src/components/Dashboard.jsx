import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToadEvents } from '../hooks/useToadEvents';
import { useToadApi } from '../hooks/useToadApi';
import { Activity, Database, Server, Check, CheckCircle, MessageSquare, Send, ShieldAlert, Trash2, Wrench, X, Zap, Clock } from 'lucide-react';

export default function Dashboard() {
  const { connected, events, lastEvent } = useToadEvents();
  const { callTool } = useToadApi();
  
  const [health, setHealth] = useState(null);
  const [runtimes, setRuntimes] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [crossTeamMessages, setCrossTeamMessages] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [crossTeamForm, setCrossTeamForm] = useState({
    targetTeamId: '',
    targetAgentId: 'lead',
    conversationId: '',
    text: '',
  });
  const [sendingCrossTeam, setSendingCrossTeam] = useState(false);
  const [actingApprovalId, setActingApprovalId] = useState(null);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState(null);
  const [runtimeEvents, setRuntimeEvents] = useState([]);
  const [runtimeTools, setRuntimeTools] = useState([]);
  const [runtimeHealth, setRuntimeHealth] = useState(null);
  const [runtimeDetailLoading, setRuntimeDetailLoading] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [healthData, runtimeData, taskData, approvalData, crossTeamData] = await Promise.all([
        callTool('health_status'),
        callTool('agent_status', { runtimeId: '' }),
        callTool('task_list'),
        callTool('approval_list'),
        callTool('cross_team_messages', { limit: 100 })
      ]);
      setHealth(healthData);
      setRuntimes(Array.isArray(runtimeData) ? runtimeData : (runtimeData ? [runtimeData] : []));
      setTasks(taskData || []);
      setApprovals(Array.isArray(approvalData) ? approvalData : []);
      setCrossTeamMessages(Array.isArray(crossTeamData) ? crossTeamData : []);
    } catch (e) {
      console.error('Failed to fetch data', e);
    }
  }, [callTool]);

  const pendingApprovals = approvals.filter(approval => approval.status === 'pending');
  const lastDrop = useMemo(
    () => events.find(event => event?.type === 'side_effects_dropped_on_restart') || null,
    [events],
  );
  const lastPrune = useMemo(
    () => events.find(event => event?.type === 'side_effects_pruned') || null,
    [events],
  );
  const lastVacuum = useMemo(
    () => events.find(event => event?.type === 'database_vacuumed') || null,
    [events],
  );
  const selectedRuntime = runtimes.find(runtime => runtime.runtimeId === selectedRuntimeId) || null;
  const crossTeamConversations = groupCrossTeamConversations(crossTeamMessages);
  const activeConversationId = crossTeamConversations.some(conversation => conversation.conversationId === selectedConversationId)
    ? selectedConversationId
    : crossTeamConversations[0]?.conversationId || '';
  const activeConversation = crossTeamConversations.find(conversation => conversation.conversationId === activeConversationId) || null;

  const fetchRuntimeDetails = useCallback(async (runtimeId = selectedRuntimeId) => {
    if (!runtimeId) return;
    setRuntimeDetailLoading(true);
    try {
      const [eventData, toolData, healthData] = await Promise.all([
        callTool('runtime_events', { runtimeId }),
        callTool('tool_activity', { runtimeId }),
        callTool('health_status', { runtimeId }),
      ]);
      setRuntimeEvents(Array.isArray(eventData) ? eventData : []);
      setRuntimeTools(Array.isArray(toolData) ? toolData : []);
      setRuntimeHealth(healthData || null);
    } catch (e) {
      console.error('Failed to fetch runtime details', e);
      setRuntimeEvents([]);
      setRuntimeTools([]);
      setRuntimeHealth(null);
    } finally {
      setRuntimeDetailLoading(false);
    }
  }, [callTool, selectedRuntimeId]);

  const handleApprovalDecision = async (approval, decision) => {
    setActingApprovalId(approval.approvalId);
    try {
      await callTool(
        'approval_respond',
        {
          idempotencyKey: `ui-approval-${approval.approvalId}-${decision}`,
          approvalId: approval.approvalId,
          decision,
          reason: decision === 'approved'
            ? 'Approved from TOAD dashboard.'
            : 'Denied from TOAD dashboard.',
        },
        {
          teamId: approval.teamId || 'local',
          agentId: 'operator',
        }
      );
      await fetchData();
    } catch (e) {
      console.error('Failed to respond to approval', e);
    } finally {
      setActingApprovalId(null);
    }
  };

  const handleCrossTeamFormChange = (field, value) => {
    setCrossTeamForm(current => ({ ...current, [field]: value }));
  };

  const handleCrossTeamSend = async (event) => {
    event.preventDefault();
    const targetTeamId = crossTeamForm.targetTeamId.trim();
    const text = crossTeamForm.text.trim();
    if (!targetTeamId || !text) return;
    const conversationId = crossTeamForm.conversationId.trim() || activeConversationId || `ui-conv-${Date.now()}`;
    setSendingCrossTeam(true);
    try {
      await callTool('cross_team_send', {
        idempotencyKey: `ui-cross-team-${Date.now()}-${targetTeamId}`,
        targetTeamId,
        targetAgentId: crossTeamForm.targetAgentId.trim() || 'lead',
        conversationId,
        text,
      });
      setCrossTeamForm(current => ({
        ...current,
        conversationId,
        text: '',
      }));
      setSelectedConversationId(conversationId);
      await fetchData();
    } catch (e) {
      console.error('Failed to send cross-team message', e);
    } finally {
      setSendingCrossTeam(false);
    }
  };

  useEffect(() => {
    const initial = setTimeout(fetchData, 0);
    // Poll every 10s as a fallback, though we have SSE
    const interval = setInterval(fetchData, 10000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [fetchData]);

  useEffect(() => {
    if (!selectedRuntimeId) return;
    const initial = setTimeout(() => fetchRuntimeDetails(selectedRuntimeId), 0);
    const interval = setInterval(() => fetchRuntimeDetails(selectedRuntimeId), 10000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [selectedRuntimeId, fetchRuntimeDetails]);

  useEffect(() => {
    if (!selectedRuntimeId) return;
    if (!runtimes.some(runtime => runtime.runtimeId === selectedRuntimeId)) {
      const closeMissingRuntime = setTimeout(() => {
        setSelectedRuntimeId(null);
        setRuntimeEvents([]);
        setRuntimeTools([]);
        setRuntimeHealth(null);
      }, 0);
      return () => clearTimeout(closeMissingRuntime);
    }
  }, [runtimes, selectedRuntimeId]);

  // Re-fetch when we get certain events
  useEffect(() => {
    if (!lastEvent) return;
    const type = lastEvent.eventType;
    if (type === 'process_started' || type === 'process_stopped' || type === 'task_created' || type === 'approval_request' || type === 'tool_use' || type === 'api_retry') {
      const refresh = setTimeout(fetchData, 0);
      return () => clearTimeout(refresh);
    }
  }, [lastEvent, fetchData]);

  useEffect(() => {
    if (!lastEvent || !selectedRuntimeId) return;
    if (lastEvent.runtimeId === selectedRuntimeId) {
      const refresh = setTimeout(() => fetchRuntimeDetails(selectedRuntimeId), 0);
      return () => clearTimeout(refresh);
    }
  }, [lastEvent, selectedRuntimeId, fetchRuntimeDetails]);

  return (
    <div className="dashboard-grid">
      {/* Top Stats */}
      <div className="col-span-12">
        <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="glass-card">
            <div className="card-header">
              <span className="card-title">Active Runtimes</span>
              <Server size={20} />
            </div>
            <div className="stat-value">{runtimes.length}</div>
            <div className="stat-label">Processes running</div>
          </div>
          
          <div className="glass-card">
            <div className="card-header">
              <span className="card-title">Events</span>
              <Activity size={20} />
            </div>
            <div className="stat-value">{events.length}</div>
            <div className="stat-label">In current session</div>
          </div>

          <div className="glass-card">
            <div className="card-header">
              <span className="card-title">Pending Tasks</span>
              <CheckCircle size={20} />
            </div>
            <div className="stat-value">{tasks.filter(t => t.status === 'pending').length}</div>
            <div className="stat-label">Awaiting action</div>
          </div>

          <div className="glass-card">
            <div className="card-header">
              <span className="card-title">Pending Approvals</span>
              <ShieldAlert size={20} style={{ color: pendingApprovals.length > 0 ? 'var(--warning-color)' : 'inherit' }} />
            </div>
            <div className="stat-value">{pendingApprovals.length}</div>
            <div className="stat-label">{health?.summary?.rateLimited || 0} API retries rate limited</div>
          </div>
        </div>
      </div>

      {/* System Housekeeping */}
      <div className="col-span-12 glass-panel animate-fade-in">
        <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
          <h2 className="card-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Wrench size={18} /> System Housekeeping
          </h2>
          <span className="stat-label" style={{ margin: 0 }}>
            updates on each <code>start()</code>
          </span>
        </div>
        <div style={{ padding: '1rem 1.5rem', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
          <HousekeepingCell
            icon={<Trash2 size={16} />}
            label="Last restart cleanup"
            event={lastDrop}
            unit="orphan"
            emptyText="No orphans cleared this session"
          />
          <HousekeepingCell
            icon={<Trash2 size={16} />}
            label="Last retention sweep"
            event={lastPrune}
            unit="row"
            emptyText="No prune events this session"
          />
          <VacuumCell event={lastVacuum} />
        </div>
      </div>

      {/* Approvals */}
      <div className="col-span-12 glass-panel animate-fade-in">
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
          <h2 className="card-title" style={{ margin: 0 }}><ShieldAlert size={20} /> Pending Approvals</h2>
          <span className={`badge ${pendingApprovals.length > 0 ? 'badge-warning' : 'badge-success'}`}>
            {pendingApprovals.length}
          </span>
        </div>
        <div style={{ padding: '1.5rem' }}>
          {pendingApprovals.length === 0 ? (
            <div className="empty-state" style={{ padding: '2rem 1rem' }}>
              <CheckCircle size={40} />
              <p>No pending approvals</p>
            </div>
          ) : (
            <div className="flex-col gap-4">
              {pendingApprovals.map(approval => {
                const input = approval.metadata?.input || approval.input || {};
                const toolName = approval.metadata?.toolName || approval.toolName || 'approval';
                const isActing = actingApprovalId === approval.approvalId;
                return (
                  <div key={approval.approvalId} className="glass-card" style={{ padding: '1rem' }}>
                    <div className="flex items-center justify-between gap-4" style={{ marginBottom: '0.75rem' }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="flex items-center gap-2" style={{ marginBottom: '0.25rem', flexWrap: 'wrap' }}>
                          <h3 style={{ margin: 0, fontSize: '1rem', overflowWrap: 'anywhere' }}>
                            {approval.prompt || `Approve ${toolName}`}
                          </h3>
                          <span className="badge badge-info">{toolName}</span>
                        </div>
                        <div className="stat-label" style={{ overflowWrap: 'anywhere' }}>
                          {approval.agentId} @ {approval.teamId} {approval.runtimeId ? `- ${approval.runtimeId}` : ''}
                        </div>
                      </div>
                      <div className="flex gap-2" style={{ flexShrink: 0 }}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => handleApprovalDecision(approval, 'approved')}
                          disabled={isActing}
                          title="Approve"
                        >
                          <Check size={16} />
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => handleApprovalDecision(approval, 'denied')}
                          disabled={isActing}
                          title="Deny"
                        >
                          <X size={16} />
                          Deny
                        </button>
                      </div>
                    </div>
                    <div className="event-payload">
                      {JSON.stringify(input, null, 2)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Cross-Team Chat */}
      <div className="col-span-12 glass-panel animate-fade-in">
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
          <h2 className="card-title" style={{ margin: 0 }}><MessageSquare size={20} /> Cross-Team Chat</h2>
          <span className="badge badge-info">{crossTeamMessages.length}</span>
        </div>
        <div className="dashboard-grid" style={{ padding: '1.5rem' }}>
          <div className="col-span-4">
            {crossTeamConversations.length === 0 ? (
              <div className="empty-state" style={{ padding: '2rem 1rem' }}>
                <MessageSquare size={40} />
                <p>No cross-team messages</p>
              </div>
            ) : (
              <div className="flex-col gap-4">
                {crossTeamConversations.map(conversation => (
                  <button
                    key={conversation.conversationId}
                    type="button"
                    className="glass-card"
                    onClick={() => {
                      setSelectedConversationId(conversation.conversationId);
                      setCrossTeamForm(current => ({ ...current, conversationId: conversation.conversationId }));
                    }}
                    style={{
                      textAlign: 'left',
                      padding: '1rem',
                      borderColor: conversation.conversationId === activeConversationId ? 'var(--border-color-strong)' : 'var(--border-color)',
                      cursor: 'pointer',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2" style={{ marginBottom: '0.35rem' }}>
                      <span className="event-type" style={{ overflowWrap: 'anywhere' }}>{conversation.peerLabel}</span>
                      <span className="badge badge-info">{conversation.messages.length}</span>
                    </div>
                    <div className="stat-label" style={{ overflowWrap: 'anywhere' }}>
                      {conversation.lastMessage?.text || conversation.conversationId}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="col-span-8">
            <div className="glass-card" style={{ padding: '1rem', marginBottom: '1rem' }}>
              <div className="card-header">
                <span className="card-title" style={{ margin: 0 }}>
                  {activeConversation ? activeConversation.peerLabel : 'Conversation'}
                </span>
                <span className="stat-label">{activeConversationId || 'new'}</span>
              </div>
              {!activeConversation ? (
                <div className="empty-state" style={{ padding: '2rem 1rem' }}>
                  <p>Select or send a conversation</p>
                </div>
              ) : (
                <div className="flex-col gap-4" style={{ maxHeight: '320px', overflowY: 'auto', paddingRight: '0.5rem' }}>
                  {activeConversation.messages.map(message => (
                    <div
                      key={message.id}
                      className="event-item"
                      style={{
                        marginLeft: message.direction === 'outbound' ? '2rem' : 0,
                        marginRight: message.direction === 'inbound' ? '2rem' : 0,
                      }}
                    >
                      <div className="event-content">
                        <div className="event-header">
                          <span className="event-type">{message.direction === 'outbound' ? 'To' : 'From'} {message.direction === 'outbound' ? message.targetTeamId : message.sourceTeamId}</span>
                          <span className="event-time">{message.createdAt ? new Date(message.createdAt).toLocaleTimeString() : 'sent'}</span>
                        </div>
                        <div style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{message.text}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <form className="glass-card" style={{ padding: '1rem' }} onSubmit={handleCrossTeamSend}>
              <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(12, 1fr)', gap: '0.75rem', marginBottom: '0.75rem' }}>
                <input
                  aria-label="Target team"
                  className="cross-team-input"
                  placeholder="target team"
                  value={crossTeamForm.targetTeamId}
                  onChange={event => handleCrossTeamFormChange('targetTeamId', event.target.value)}
                  style={inputStyle({ gridColumn: 'span 4' })}
                />
                <input
                  aria-label="Target agent"
                  className="cross-team-input"
                  placeholder="lead"
                  value={crossTeamForm.targetAgentId}
                  onChange={event => handleCrossTeamFormChange('targetAgentId', event.target.value)}
                  style={inputStyle({ gridColumn: 'span 3' })}
                />
                <input
                  aria-label="Conversation ID"
                  className="cross-team-input"
                  placeholder={activeConversationId || 'conversation id'}
                  value={crossTeamForm.conversationId}
                  onChange={event => handleCrossTeamFormChange('conversationId', event.target.value)}
                  style={inputStyle({ gridColumn: 'span 5' })}
                />
              </div>
              <div className="flex gap-2">
                <textarea
                  aria-label="Cross-team message"
                  placeholder="Message another team..."
                  value={crossTeamForm.text}
                  onChange={event => handleCrossTeamFormChange('text', event.target.value)}
                  rows={3}
                  style={inputStyle({ resize: 'vertical', flex: 1 })}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={sendingCrossTeam || !crossTeamForm.targetTeamId.trim() || !crossTeamForm.text.trim()}
                  title="Send cross-team message"
                  style={{ alignSelf: 'stretch', minWidth: '96px' }}
                >
                  <Send size={16} />
                  Send
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      {/* Runtimes */}
      <div className="col-span-8 glass-panel animate-fade-in">
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between' }}>
          <h2 className="card-title" style={{ margin: 0 }}><Zap size={20} /> Runtime Topologies</h2>
        </div>
        <div style={{ padding: '1.5rem' }}>
          {runtimes.length === 0 ? (
            <div className="empty-state">
              <Server size={48} />
              <p>No active runtimes</p>
            </div>
          ) : (
            <div className="flex-col gap-4">
              {runtimes.map(rt => (
                <div key={rt.runtimeId} className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem' }}>
                  <div>
                    <div className="flex items-center gap-2" style={{ marginBottom: '0.25rem' }}>
                      <h3 style={{ margin: 0, fontSize: '1rem' }}>{rt.runtimeId}</h3>
                      <span className={`badge ${rt.status === 'running' ? 'badge-success' : 'badge-warning'}`}>
                        {rt.status}
                      </span>
                    </div>
                    <div className="stat-label">{rt.agentId} @ {rt.teamId}</div>
                  </div>
                  <div className="flex items-center gap-4" style={{ flexShrink: 0 }}>
                    <div className="stat-label" style={{ fontFamily: 'var(--font-mono)' }}>
                      PID: {rt.pid || 'N/A'}
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setSelectedRuntimeId(rt.runtimeId)}
                      title="Open runtime details"
                    >
                      Details
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Event Stream */}
      <div className="col-span-4 glass-panel animate-fade-in" style={{ animationDelay: '0.1s' }}>
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="card-title" style={{ margin: 0 }}><Activity size={20} /> Live Stream</h2>
          <span className={`badge ${connected ? 'badge-success' : 'badge-error'}`}>
            {connected ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
        <div style={{ padding: '1.5rem' }}>
          <div className="event-list">
            {events.length === 0 ? (
              <div className="empty-state">
                <Clock size={32} />
                <p>Waiting for events...</p>
              </div>
            ) : (
              events.map((ev, i) => (
                <div key={ev.eventId || i} className="event-item">
                  <div className="event-icon" style={{ background: 'var(--primary-light)', color: 'var(--primary-color)' }}>
                    <Activity size={16} />
                  </div>
                  <div className="event-content">
                    <div className="event-header">
                      <span className="event-type">{ev.eventType}</span>
                      <span className="event-time">{ev.createdAt ? new Date(ev.createdAt).toLocaleTimeString() : 'live'}</span>
                    </div>
                    <div className="stat-label">{ev.runtimeId || ev.teamId}</div>
                    {ev.payload && (
                      <div className="event-payload">
                        {JSON.stringify(ev.payload, null, 2)}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {selectedRuntime && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.35)',
            zIndex: 30,
            display: 'flex',
            justifyContent: 'flex-end',
          }}
          onClick={() => setSelectedRuntimeId(null)}
        >
          <aside
            className="glass-panel"
            style={{
              width: 'min(560px, 100vw)',
              height: '100vh',
              borderRadius: 0,
              borderTop: 0,
              borderRight: 0,
              borderBottom: 0,
              overflowY: 'auto',
              padding: '1.5rem',
            }}
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4" style={{ marginBottom: '1.5rem' }}>
              <div style={{ minWidth: 0 }}>
                <h2 className="card-title" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                  <Server size={20} /> {selectedRuntime.runtimeId}
                </h2>
                <div className="stat-label" style={{ marginTop: '0.35rem' }}>
                  {selectedRuntime.agentId} @ {selectedRuntime.teamId}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setSelectedRuntimeId(null)}
                title="Close"
                style={{ flexShrink: 0 }}
              >
                <X size={16} />
              </button>
            </div>

            <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: '1.5rem' }}>
              <div className="glass-card" style={{ padding: '1rem' }}>
                <div className="stat-label">Status</div>
                <div className="event-type" style={{ marginTop: '0.35rem' }}>{selectedRuntime.status}</div>
              </div>
              <div className="glass-card" style={{ padding: '1rem' }}>
                <div className="stat-label">PID</div>
                <div className="event-type" style={{ marginTop: '0.35rem' }}>{selectedRuntime.pid || 'N/A'}</div>
              </div>
              <div className="glass-card" style={{ padding: '1rem' }}>
                <div className="stat-label">Provider</div>
                <div className="event-type" style={{ marginTop: '0.35rem' }}>{selectedRuntime.providerId || 'unknown'}</div>
              </div>
              <div className="glass-card" style={{ padding: '1rem' }}>
                <div className="stat-label">API Retries</div>
                <div className="event-type" style={{ marginTop: '0.35rem' }}>
                  {runtimeHealth?.summary?.total || 0} total
                </div>
              </div>
            </div>

            {runtimeDetailLoading && (
              <div className="stat-label" style={{ marginBottom: '1rem' }}>Refreshing runtime details...</div>
            )}

            <RuntimeDetailSection
              title="Recent Events"
              items={runtimeEvents}
              emptyText="No recent runtime events"
              getTitle={item => item.eventType || item.type || item.eventId}
              getSubtitle={item => item.createdAt ? new Date(item.createdAt).toLocaleTimeString() : item.runtimeId}
              getPayload={item => item.payload || item}
            />

            <RuntimeDetailSection
              title="Tool Calls"
              items={runtimeTools}
              emptyText="No recent tool calls"
              getTitle={item => item.toolName || item.type || item.id}
              getSubtitle={item => item.createdAt ? new Date(item.createdAt).toLocaleTimeString() : item.runtimeId}
              getPayload={item => item.input || item}
            />

            <RuntimeDetailSection
              title="API Retries"
              items={runtimeHealth?.retries || []}
              emptyText="No API retries for this runtime"
              getTitle={item => item.error || `HTTP ${item.errorStatus || 'error'}`}
              getSubtitle={item => item.createdAt ? new Date(item.createdAt).toLocaleTimeString() : item.runtimeId}
              getPayload={item => item}
            />
          </aside>
        </div>
      )}
    </div>
  );
}

function RuntimeDetailSection({ title, items, emptyText, getTitle, getSubtitle, getPayload }) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <div className="card-header" style={{ marginBottom: '0.75rem' }}>
        <h3 className="card-title" style={{ margin: 0 }}>{title}</h3>
        <span className="badge badge-info">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="empty-state" style={{ padding: '1.5rem 1rem' }}>
          <p>{emptyText}</p>
        </div>
      ) : (
        <div className="flex-col gap-4">
          {items.slice(0, 8).map((item, index) => (
            <div key={item.eventId || item.id || item.toolUseId || index} className="event-item">
              <div className="event-content">
                <div className="event-header">
                  <span className="event-type">{getTitle(item)}</span>
                  <span className="event-time">{getSubtitle(item)}</span>
                </div>
                <div className="event-payload">
                  {JSON.stringify(getPayload(item), null, 2)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function HousekeepingCell({ icon, label, event, unit, emptyText }) {
  if (!event) {
    return (
      <div className="glass-card" style={{ padding: '1rem' }}>
        <div className="card-header" style={{ marginBottom: '0.5rem' }}>
          <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {icon} {label}
          </span>
        </div>
        <div className="empty-state" style={{ padding: '0.5rem 0' }}>
          <p style={{ margin: 0 }}>{emptyText}</p>
        </div>
      </div>
    );
  }
  const count = Number.isFinite(event.count) ? event.count : 0;
  const unitLabel = count === 1 ? unit : `${unit}s`;
  return (
    <div className="glass-card" style={{ padding: '1rem' }}>
      <div className="card-header" style={{ marginBottom: '0.5rem' }}>
        <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {icon} {label}
        </span>
      </div>
      <div className="stat-value">{count}</div>
      <div className="stat-label">{unitLabel} · {formatRelativeTime(event.createdAt)}</div>
    </div>
  );
}

function VacuumCell({ event }) {
  if (!event) {
    return (
      <div className="glass-card" style={{ padding: '1rem' }}>
        <div className="card-header" style={{ marginBottom: '0.5rem' }}>
          <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Database size={16} /> Last database vacuum
          </span>
        </div>
        <div className="empty-state" style={{ padding: '0.5rem 0' }}>
          <p style={{ margin: 0 }}>No vacuum events this session</p>
        </div>
      </div>
    );
  }
  const before = Number.isFinite(event.freelistBefore) ? event.freelistBefore : 0;
  const after = Number.isFinite(event.freelistAfter) ? event.freelistAfter : 0;
  const reclaimed = Math.max(0, before - after);
  return (
    <div className="glass-card" style={{ padding: '1rem' }}>
      <div className="card-header" style={{ marginBottom: '0.5rem' }}>
        <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Database size={16} /> Last database vacuum
        </span>
      </div>
      <div className="stat-value">{reclaimed}</div>
      <div className="stat-label">freelist {reclaimed === 1 ? 'page' : 'pages'} reclaimed · {formatRelativeTime(event.createdAt)}</div>
    </div>
  );
}

function formatRelativeTime(iso) {
  if (!iso) return 'unknown';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaSec = Math.floor((Date.now() - then) / 1000);
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

function groupCrossTeamConversations(messages) {
  const groups = new Map();
  for (const message of messages) {
    const conversationId = message.conversationId || message.id;
    const group = groups.get(conversationId) || {
      conversationId,
      messages: [],
      lastMessage: null,
      peerLabel: 'Cross-team',
    };
    group.messages.push(message);
    group.lastMessage = message;
    const peerTeam = message.direction === 'outbound' ? message.targetTeamId : message.sourceTeamId;
    const peerAgent = message.direction === 'outbound' ? message.targetAgentId : message.sourceAgentId;
    group.peerLabel = peerAgent ? `${peerTeam}.${peerAgent}` : peerTeam || 'Cross-team';
    groups.set(conversationId, group);
  }
  return [...groups.values()].sort((left, right) => {
    const leftTime = Date.parse(left.lastMessage?.createdAt || '');
    const rightTime = Date.parse(right.lastMessage?.createdAt || '');
    return rightTime - leftTime;
  });
}

function inputStyle(extra = {}) {
  return {
    width: '100%',
    minWidth: 0,
    background: 'rgba(0, 0, 0, 0.2)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
    fontSize: '0.875rem',
    padding: '0.65rem 0.75rem',
    outline: 'none',
    ...extra,
  };
}
