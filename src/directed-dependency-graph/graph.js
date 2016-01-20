import EventEmitter from 'events';
import {pull, remove} from 'lodash/array';
import {contains} from 'lodash/collection';
import {clone} from 'lodash/lang';
import {addNode, addEdge, pruneFromNode, removeEdge, removeNode} from './utils';

/*
Events
------

start
complete

added [node]
pruned [node]
error [err, node]

tracing [node]
traced [node]

*/

/*
 we need a notion of 'jobs', to enable async
 invalidation and resolution.

 `pending` should be a list of objects where
 each object takes the form:
 {
 node: '...',
 isValid: true
 }

 if a node is ever invalidated while a job is pending,
 the `isValid` property should be set to false, so that
 when that job completes, it will discard its results
 */

/*
 Handle node change while tracing:
 given predecessors [a, b, ...] -> c

 if c changes during dep resolution:
 when c's dep resolution has completed:
 if c's job is still active:
 update graph
 else:
 discard results
 */

/*
 Handle node change:
 given predecessors [a, b, ...] -> c

 when c changes:
 deps = []
 for predecessor of c:
 deps += getDeps(predecessor)
 rebuildGraph(deps)
 */

/*
 When pruning, we'll need a notion of entry points,
 so that we can safely prune the tree without
 removing required nodes.

 Also need to take into consideration that `trace`
 may be called by iteration functions which provide
 index values of an object. Should make sure that
 defining an entry point is an explicit process
 */

export function createGraph({getDependencies}={}) {
  const nodes = Object.create(null);
  const permanentNodes = [];
  const events = new EventEmitter;
  const pendingJobs = [];

  function traceNode(node) {
    const job = {
      node,
      isValid: true
    };

    pendingJobs.push(job);

    process.nextTick(startTracingNode);

    function removeJob() {
      pull(pendingJobs, job);
    }

    function startTracingNode() {
      // Allow jobs to be cancelled synchronously
      if (!job.isValid) {
        return removeJob();
      }

      getDependencies(node, (err, dependencies) => {
        removeJob();

        if (err) {
          return events.emit('error', err, node);
        }

        // Allow jobs to be cancelled asynchronously
        if (!job.isValid) {
          return;
        }

        const nodesAdded = [];

        if (!nodes[node]) {
          addNode(nodes, node);
          nodesAdded.push(node);
        }

        dependencies.forEach(depNode => {
          if (!isNodeDefined(nodes, depNode) && !isNodePending(pendingJobs, depNode)) {
            traceNode(depNode);
          }

          if (!nodes[depNode]) {
            addNode(nodes, depNode);
            nodesAdded.push(depNode);
          }

          addEdge(nodes, node, depNode);
        });

        nodesAdded.forEach(node => {
          events.emit('added', node);
        });

        process.nextTick(() => {
          if (!pendingJobs.length) {
            events.emit('complete');
          }
        });
      });
    }
  }

  function pruneNode(node) {
    if (isNodeDefined(nodes, node)) {
      const prunedNodes = pruneFromNode(nodes, node, permanentNodes);
      prunedNodes.forEach(prunePendingJobsAndEmit);
    } else if (isNodePending(pendingJobs, node)) {
      prunePendingJobsAndEmit(node);
    }

    function prunePendingJobsAndEmit(node) {
      pendingJobs
        .filter(job => job.node === node)
        .forEach(job => job.isValid = false);

      events.emit('pruned', node);
    }
  }

  function setNodeAsPermanent(node) {
    return ensureNodeIsPermanent(permanentNodes, node);
  }

  return {
    nodes,
    permanentNodes,
    pendingJobs,
    events,
    traceNode,
    setNodeAsPermanent,
    pruneNode,
    isNodeDefined(node) {
      return isNodeDefined(nodes, node);
    }
  };
}

export function ensureNodeIsPermanent(permanentNodes, node) {
  if (!contains(permanentNodes, node)) {
    permanentNodes.push(node);
  }
}

export function isNodeDefined(nodes, node) {
  return !!nodes[node];
}

export function isNodePending(pendingJobs, node) {
  return pendingJobs.some(job => job.isValid && job.node === node);
}
