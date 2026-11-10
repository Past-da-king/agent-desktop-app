#!/bin/bash
# Renders the showcase stills from the real Compose screens. Usage: run-phone.sh (on the impetix server).
cd ~/showcase/phone || exit 1
echo "sdk.dir=/home/impetix/android-sdk" > local.properties
export JAVA_HOME=/home/impetix/jdks/jdk-21.0.12.1+1
rm -rf app/build/showcase
~/bin/build-slot ./gradlew -Dorg.gradle.java.installations.paths=$JAVA_HOME :app:testDebugUnitTest --tests "com.past9.phoneaos.ShowcaseShotsTest" > ~/showcase/phone-run.log 2>&1
echo "exit $?" >> ~/showcase/phone-run.log
ls app/build/showcase 2>/dev/null >> ~/showcase/phone-run.log
