// ── Platform (paas) — build image on the cheap cluster, push to Harbor ────────
//
// Runs on the built-in agent: the Jenkins pod on cheap-3 with the host's docker
// CLI + /var/run/docker.sock mounted, so `docker build` uses cheap-3's daemon —
// the one whose daemon.json already lists 100.64.0.8:30880 as an insecure
// registry. Nothing here talks to Docker Hub, which cheap-3 cannot reach.
//
// This is the alternative to .github/workflows/docker-deploy.yml (which builds
// on a GitHub runner and pushes to the America Harbor): that leg is both
// cross-border and GFW-throttled, and its cached cold build was slow enough to
// need a 240m ceiling. On-LAN, the registry is a few hops away.
//
// The image is the same artifact the workflow produces — same `sha-<7>` +
// `latest` tags — so either path feeds the same manifests.
//
// Credential `harbor-platform` is the Harbor robot `robot$paas_private+ci-push-platform`
// (project-scoped to paas_private, push + pull, no expiry).

pipeline {
  agent any

  options {
    timestamps()
    // Cold builds are the norm, not the exception: native addons (better-sqlite3,
    // tree-sitter) compile from source, scripts/build-node.js downloads a
    // standalone Node release, and vite builds the SPA — and nothing is cached
    // between runs (no BuildKit cache export here). Generous ceiling on purpose;
    // a false timeout throws away 40 minutes of work.
    timeout(time: 120, unit: 'MINUTES')
    // Two builds would fight over the same `latest` tag AND over this node's
    // 30 GB disk, which it shares with the running platform pod (the post
    // prune below keeps the leftovers bounded).
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    REGISTRY   = '100.64.0.8:30880'
    IMAGE      = '100.64.0.8:30880/paas_private/platform'
    // cheap-3 cannot reach registry-1.docker.io, so the Dockerfile's default
    // (node:25-bookworm-slim) is overridden with the cluster's own mirror.
    BASE_IMAGE = '100.64.0.8:30880/library/node:25-bookworm-slim'
  }

  stages {
    stage('Resolve tag') {
      steps {
        script {
          env.GIT_SHA = sh(returnStdout: true, script: 'git rev-parse --short=7 HEAD').trim()
          env.TAG = "sha-${env.GIT_SHA}"
          echo "Building ${env.IMAGE}:${env.TAG}"
        }
      }
    }

    stage('Build') {
      steps {
        sh 'docker build --build-arg BASE_IMAGE="$BASE_IMAGE" -t "$IMAGE:$TAG" -t "$IMAGE:latest" -f Dockerfile .'
      }
    }

    // Boot the image before pushing it. A build that compiles is not an image
    // that runs: two revisions of this pipeline produced images that bound port
    // 3000 and then died moments later — one with @llamaindex/core pruned out of
    // node_modules (ERR_MODULE_NOT_FOUND), one whose runtime stage omitted the
    // dsh-profile-template/ dir that dsh-profile.js reads at startup (ENOENT).
    // Neither shows up at build time. This is what shows up.
    stage('Smoke test') {
      steps {
        sh '''
          set -e
          docker rm -f platform-smoke >/dev/null 2>&1 || true
          # No published port and no bind mount, both deliberately:
          #  * a -v path is resolved by the HOST daemon while this script runs
          #    inside the Jenkins pod, so a directory created here is not the one
          #    that gets mounted; docker then silently creates a root-owned dir
          #    that the container's UID 1000 cannot write, and the app dies in
          #    first-run with EACCES. The image already ships a writable /data,
          #    which is all this test wants anyway.
          #  * -p would publish on the HOST's loopback, which this pod cannot
          #    reach, so the probe would fail even on a perfectly good image.
          # The image ships curl, and the probe below runs inside the
          # container's own netns — nothing has to leave it.
          docker run -d --name platform-smoke \
            -e AUTH_MODE=none -e PORT=3000 -e HOST=0.0.0.0 \
            -e PLATFORM_DATA_DIR=/data -e NODE_ENV=production \
            "$IMAGE:$TAG" >/dev/null
          ok=0
          for i in $(seq 1 40); do
            sleep 5
            if docker exec platform-smoke curl -fsS -m 5 http://127.0.0.1:3000/api/config >/dev/null 2>&1; then
              ok=1; echo "smoke: /api/config healthy after ~$((i*5))s"; break
            fi
            # server.js binds the port BEFORE it finishes async agent init, so a
            # crash lands after a listening socket appeared — polling the probe
            # alone would just look like a slow start. Catch the death directly.
            if [ "$(docker inspect -f '{{.State.Running}}' platform-smoke 2>/dev/null)" != "true" ]; then
              echo "smoke: container exited after ~$((i*5))s"; break
            fi
          done
          if [ "$ok" != "1" ]; then
            echo "SMOKE TEST FAILED — image does not serve /api/config; logs follow"
            docker logs platform-smoke 2>&1 | tail -40
            exit 1
          fi
        '''
      }
    }

    stage('Push to Harbor') {
      steps {
        withCredentials([usernamePassword(credentialsId: 'harbor-platform',
                                          usernameVariable: 'HARBOR_USER',
                                          passwordVariable: 'HARBOR_PASS')]) {
          sh '''
            set -e
            echo "$HARBOR_PASS" | docker login "$REGISTRY" -u "$HARBOR_USER" --password-stdin
            docker push "$IMAGE:$TAG"
            docker push "$IMAGE:latest"
          '''
        }
      }
    }
  }

  post {
    always {
      // Also drops the smoke container: the stage exits early on failure without
      // cleaning up, and `docker run` would then refuse the next build's name.
      sh 'docker rm -f platform-smoke >/dev/null 2>&1 || true'
      sh 'docker logout "$REGISTRY" || true'
      // Reclaim build leftovers — this node's 30 GB disk also hosts the running
      // platform pod, and unused images accumulated to 20 GB on 2026-09-29,
      // tripping DiskPressure and evicting production. The pushed image is the
      // artifact of record in Harbor, so nothing here risks a rollback (a
      // re-pull from the LAN registry is fast). 24 h retention keeps the base
      // image warm for back-to-back builds while bounding growth to a day of
      // builds; images of running containers (the ingress proxy) are never
      // pruned. `|| true` so cleanup can never fail the build.
      sh '''
        docker image prune -a -f --filter until=24h || true
        docker builder prune -a -f --filter until=24h || true
        docker container prune -f || true
      '''
    }
    // The tag is what the ArgoCD manifest needs to reference; it is deliberately
    // not bumped here (same as law-bench) — the platform manifest is committed by
    // hand so a deploy is always a reviewable commit.
    success { echo "Pushed ${IMAGE}:${TAG} — set this tag in fd-infra-deploy/all-services/prod/platform.yaml" }
  }
}
